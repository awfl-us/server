// Native fork/join admission across *independent Jobs processes*, not merely
// across in-memory recursion. Firestore owns eight CAS lease slots per root.
// Waiting fork coordinators never hold slots; only Rust subprocesses and
// non-fork external handlers do. A lost lease aborts cooperative work and
// prevents its caller from treating the result as a successful dispatch.
import { randomUUID } from 'node:crypto';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A 120-second lease is renewed every 10 seconds. Replacing a dead holder
 * increments its epoch: stale renew/release cannot change the new lease.
 * This is admission fencing, not a way to undo an HTTP effect already sent
 * by an unresponsive process. The native effect journal still owns replay.
 */
export function createDistributedExecutionBudget({
  store, rootExecutionId, userId, projectId, localBudget,
  capacity = 8, leaseMs = 120_000, renewEveryMs = 10_000,
  retryMs = 125, waitTimeoutMs = 120_000,
  clock = () => Date.now(), wait = sleep,
}) {
  if (!store?.tryAcquirePermit || !store?.renewPermit || !store?.releasePermit ||
      typeof localBudget !== 'function' ||
      !/^native_[a-f0-9]{32}$/.test(rootExecutionId || '') ||
      !userId || !projectId || !Number.isSafeInteger(capacity) ||
      capacity < 1 || capacity > 8 ||
      !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 600_000 ||
      !Number.isSafeInteger(renewEveryMs) || renewEveryMs < 10 ||
      renewEveryMs * 2 >= leaseMs ||
      !Number.isSafeInteger(retryMs) || retryMs < 10 || retryMs > 30_000 ||
      !Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs < 100 ||
      waitTimeoutMs > 3_600_000) {
    throw new Error('invalid durable native execution budget configuration');
  }
  return work => localBudget(async () => {
    const permitId = 'permit_' + randomUUID().replaceAll('-', '');
    const args = { rootExecutionId, userId, projectId, permitId, leaseMs };
    const deadline = clock() + waitTimeoutMs;
    let permit;
    // Rotate first candidate to avoid hammering slot 0 when all processes
    // start together. Each slot is an independent transactional Firestore doc.
    const first = Number.parseInt(permitId.slice(-6), 16) % capacity;
    while (!permit) {
      for (let offset = 0; offset < capacity && !permit; offset++) {
        permit = await store.tryAcquirePermit({ ...args,
          slot: (first + offset) % capacity });
      }
      if (permit) break;
      const remaining = deadline - clock();
      if (remaining <= 0) {
        throw new Error('native distributed concurrency capacity exhausted');
      }
      await wait(Math.min(retryMs, remaining));
    }

    const leaseArgs = { ...args, slot: permit.slot, epoch: permit.epoch };
    const controller = new AbortController();
    let renewal = null, leaseFailure = null;
    const heartbeat = setInterval(() => {
      if (renewal || leaseFailure) return;
      renewal = store.renewPermit(leaseArgs).catch(error => {
        leaseFailure = error;
        controller.abort(error);
      }).finally(() => { renewal = null; });
    }, renewEveryMs);
    heartbeat.unref?.();

    let result, failure = null;
    try { result = await work(controller.signal); }
    catch (error) { failure = error; }
    finally {
      clearInterval(heartbeat);
      if (renewal) await renewal;
      try { await store.releasePermit(leaseArgs); }
      catch (error) { failure ||= error; }
    }
    if (leaseFailure) throw leaseFailure;
    if (failure) throw failure;
    return result;
  });
}
