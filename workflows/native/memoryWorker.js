// Memory-first native executor. The workflow author owns caching/idempotency;
// no implicit per-effect Firestore journal or recovery checkpoint is written.
// The existing Rust JSON continuation protocol is sufficient for this path.
import { randomUUID } from 'node:crypto';
import { runNativeArtifact, buildNativeTrustedGlobals } from './runner.js';
import { tagNativeValue } from './executionStore.js';
import { createNativeProgressWriter } from './progressWriter.js';

const EXECUTION_LEASE_MS = 30 * 60 * 1000; // Cloud Tasks dispatch deadline.
const MAX_TRANSITIONS = 10_000;

export async function runNativeMemoryWorkflow({
  store, releases, handlers, executionId, userId, projectId,
  workerId = 'worker_' + randomUUID().replaceAll('-', ''),
  profiler = null, progressIntervalMs = 1500,
  runArtifact = runNativeArtifact,
}) {
  // The claim authenticates the owner and pins the execution in one
  // transaction. A second delivery cannot execute during this live lease.
  const state = await store.claim({ executionId, workerId,
    leaseMs: EXECUTION_LEASE_MS, expectedUserId: userId,
    expectedProjectId: projectId, expectedExecutionMode: 'memory' });
  if (state.completed) return state.result;
  if (state.failed) return { status: 'failed', error: state.error };
  if (state.cancelled) return { status: 'cancelled' };
  if (state.executionMode !== 'memory' || state.status !== 'running' ||
      state.userId !== userId || state.projectId !== projectId ||
      state.protocolVersion !== 2 || state.parallelVersion === 1 ||
      !Array.isArray(state.allowedOperations) || !state.workflowName) {
    throw new Error('native memory execution does not match pinned release and owner');
  }

  const epoch = state.epoch;
  let artifact;
  try {
    artifact = await releases.materialize(state.artifactSha256);
    if (artifact.sha256 !== state.artifactSha256) {
      throw new Error('native memory artifact digest mismatch');
    }
  } catch (error) {
    await artifact?.cleanup?.();
    const failure = { message: 'native artifact unavailable', code: null };
    await store.fail({ executionId, workerId, epoch, error: failure, effectCount: 0 });
    return { status: 'failed', error: failure };
  }
  const identity = Object.freeze({ userId, projectId });
  const globals = state.trustedGlobalsVersion === 1
    ? buildNativeTrustedGlobals({ state, executionId }) : null;
  const writer = createNativeProgressWriter(
    progress => store.updateMemoryProgress({ executionId, workerId, epoch, progress }),
    { intervalMs: progressIntervalMs });

  let effectCount = 0;
  let continuation = null;
  let closed = false;
  let terminalCommitStarted = false;
  const close = async () => {
    if (!closed) { closed = true; await writer.close(); }
  };
  try {
    for (let transition = 0; transition < MAX_TRANSITIONS; transition++) {
      const call = () => runArtifact({
        executable: artifact.executable, sha256: artifact.sha256, profiler,
        input: { protocol_version: 2, input: state.input,
          ...(globals && { trusted_globals: globals }),
          ...(continuation && { continuation }) },
      });
      const response = profiler ? await profiler.measure('runner.transition', call)
        : await call();
      if (!response || response.protocol_version !== 2) {
        throw new Error('invalid native memory IPC version');
      }
      if (response.status === 'completed' || response.status === 'failed') {
        await close(); // Never let progress race the terminal Firestore write.
        if (response.status === 'failed') {
          terminalCommitStarted = true;
          await store.fail({ executionId, workerId, epoch,
            error: response.error, effectCount });
          return { status: 'failed', error: response.error };
        }
        terminalCommitStarted = true;
        await store.complete({ executionId, workerId, epoch,
          result: response.result, effectCount });
        return response.result;
      }
      if (response.status !== 'suspended' || !response.effect || !response.continuation) {
        throw new Error('invalid native memory suspension');
      }
      const { effect } = response;
      const next = response.continuation;
      if (!state.allowedOperations.includes(effect.operation) ||
          effect.operation === 'native.parallel' ||
          typeof handlers[effect.operation] !== 'function') {
        throw new Error('operation not allowed in native memory execution');
      }
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(effect.effect_id || '') ||
          !/^s[0-9]+$/.test(effect.result_slot || '') ||
          !Number.isSafeInteger(next.next_step) || next.next_step < 0 ||
          !Array.isArray(next.frames) || next.frames.length !== 0 ||
          !next.slots || typeof next.slots !== 'object' || Array.isArray(next.slots)) {
        throw new Error('invalid native memory continuation');
      }
      writer.publish({ stage: 'effect', nodeId: effect.node_id,
        effectCount, continuation: next });
      try {
        const operation = () => handlers[effect.operation]({
          args: effect.args, identity,
          // The handler may forward this hint, but the engine does NOT
          // deduplicate or persist effects. The workflow owns idempotency.
          idempotencyKey: `${executionId}:${effect.effect_id}`,
        });
        const outcome = profiler ? await profiler.measure('dispatcher.total', operation)
          : await operation();
        continuation = { ...next, slots: {
          ...next.slots, [effect.result_slot]: tagNativeValue(outcome),
        } };
      } catch (error) {
        const onError = effect.on_error;
        if (!onError || !Number.isSafeInteger(onError.next_step) ||
            !/^s[0-9]+$/.test(onError.error_slot || '')) throw error;
        const httpCode = error?.response?.status ?? error?.status ?? null;
        const failure = { message: Number.isSafeInteger(httpCode)
          ? `HTTP ${httpCode}` : 'native effect failed',
        code: Number.isSafeInteger(httpCode) && httpCode >= 400 && httpCode <= 599
          ? httpCode : null };
        continuation = { ...next, next_step: onError.next_step,
          slots: { ...next.slots, [onError.error_slot]: tagNativeValue(failure) } };
      }
      effectCount++;
      writer.publish({ stage: 'running', effectCount, continuation });
    }
    throw new Error('native memory transition limit reached');
  } catch (error) {
    await close();
    if (terminalCommitStarted) throw error;
    const failure = { message: String(error?.message || 'native execution failed').slice(0, 256),
      code: null };
    // An actual workflow failure is terminal; retrying uncached side effects
    // automatically would defeat the explicit-cache contract.
    await store.fail({ executionId, workerId, epoch,
      error: failure, effectCount });
    return { status: 'failed', error: failure };
  } finally {
    await close();
    await artifact.cleanup();
  }
}
