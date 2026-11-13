// Durable detached native launches: Firestore is the source of truth, while
// the running GKE Jobs process provides cheap bounded in-process dispatch.
// A restart scans pending records and attempts to reclaim expired leases.
// The existing execution store fences racing consumers and external effects.
const EXEC_ID = /^native_[a-f0-9]{32}$/;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export function createNativeAsyncScheduler({
  store, execute, concurrency = 4, pollIntervalMs = 15_000,
  logError = error => console.error('Native detached execution:', error?.message || error),
}) {
  if (!store?.get || typeof execute !== 'function' ||
      !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32 ||
      !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1000) {
    throw new Error('invalid native detached scheduler configuration');
  }
  const queued = new Map();
  const active = new Map();
  let started = false, closed = false, timer = null, scanning = false;

  const pump = () => {
    if (closed) return;
    while (active.size < concurrency && queued.size > 0) {
      const [id, owner] = queued.entries().next().value;
      queued.delete(id);
      if (active.has(id)) continue;
      const task = Promise.resolve().then(() => execute({
        executionId: id, userId: owner.userId, projectId: owner.projectId,
      })).catch(logError).finally(() => {
        active.delete(id);
        pump();
      });
      active.set(id, task);
    }
  };

  const enqueue = ({ executionId, userId, projectId }) => {
    if (closed || !EXEC_ID.test(executionId || '') ||
        typeof userId !== 'string' || !userId ||
        typeof projectId !== 'string' || !projectId) {
      throw new Error('invalid native detached launch');
    }
    if (!queued.has(executionId) && !active.has(executionId)) {
      queued.set(executionId, { userId, projectId });
      queueMicrotask(pump);
    }
  };

  const scan = async () => {
    if (closed || scanning || !store.listPendingAsync) return;
    scanning = true;
    try {
      const states = await store.listPendingAsync(100);
      const now = Date.now();
      for (const state of states) {
        if (!state.asyncLaunch || TERMINAL.has(state.status) ||
            (state.owner && state.leaseUntil > now)) continue;
        enqueue({ executionId: state.executionId,
          userId: state.userId, projectId: state.projectId });
      }
    } catch (error) { logError(error); }
    finally { scanning = false; }
  };

  const start = () => {
    if (!started && !closed) {
      started = true;
      timer = setInterval(() => { void scan(); }, pollIntervalMs);
      timer.unref?.();
      void scan();
    }
    return { enqueue, scan, drain, close };
  };

  const drain = async () => {
    // Development and test helper: wait for currently queued/running work,
    // including recursively launched children, but do not poll for new work.
    while (queued.size || active.size) {
      if (queued.size && !active.size) pump();
      await Promise.allSettled([...active.values()]);
    }
  };
  const close = async () => {
    closed = true;
    if (timer) clearInterval(timer);
    queued.clear();
    await Promise.allSettled([...active.values()]);
  };
  return { enqueue, start, scan, drain, close,
    get activeCount() { return active.size; },
    get queuedCount() { return queued.size; },
  };
}
