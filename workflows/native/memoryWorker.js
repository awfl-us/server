// Memory-first native executor. The workflow author owns caching/idempotency;
// no implicit per-effect Firestore journal or recovery checkpoint is written.
// The existing Rust JSON continuation protocol is sufficient for this path.
import { randomUUID } from 'node:crypto';
import { runNativeArtifact, buildNativeTrustedGlobals } from './runner.js';
import { createNativeLocalRunner } from './localWorkflows.js';
import { createNativeProgressWriter } from './progressWriter.js';
import { createMemoryDetachedLauncher } from './memoryDetached.js';

const EXECUTION_LEASE_MS = 30 * 60 * 1000; // Cloud Tasks dispatch deadline.
const MAX_TRANSITIONS = 10_000;

export async function runNativeMemoryWorkflow({
  store, releases, handlers, executionId, userId, projectId,
  workerId = 'worker_' + randomUUID().replaceAll('-', ''),
  profiler = null, progressIntervalMs = 1500,
  runArtifact = runNativeArtifact, asyncScheduler = null,
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
      state.protocolVersion !== 2 ||
      !Array.isArray(state.allowedOperations) ||
      (state.parallelVersion === 1) !==
        state.allowedOperations.includes('native.parallel') || !state.workflowName) {
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

  let terminalCommitStarted = false;
  let closed = false;
  const close = async () => {
    if (!closed) { closed = true; await writer.close(); }
  };
  // Non-detached tests and fixtures need only materialize(); resolve the
  // durable child launcher on demand if a workflow actually detaches.
  let detachedLauncher;
  const runner = createNativeLocalRunner({
    releases, handlers, rootExecutionId: executionId, identity, profiler,
    runArtifact, onProgress: progress => writer.publish(progress),
    runDetached: request => {
      detachedLauncher ||= createMemoryDetachedLauncher({
        store, releases, handlers, executionId, userId, projectId,
        asyncScheduler,
      });
      return detachedLauncher(request);
    },
  });
  try {
    const result = await runner.run({
      workflowName: state.workflowName,
      release: { sha256: state.artifactSha256,
        allowedOperations: state.allowedOperations,
        ...(state.parallelVersion === 1 && { parallelVersion: 1 }),
        ...(state.streamIpcVersion === 1 && { streamIpcVersion: 1 }) },
      artifact, input: state.input, executionId, globals,
    });
    await close(); // Drain any pending snapshot before terminal commit.
    terminalCommitStarted = true;
    await store.complete({ executionId, workerId, epoch,
      result, effectCount: runner.effectCount });
    return result;
  } catch (error) {
    await close();
    if (terminalCommitStarted) throw error;
    const failure = error?.nativeError || {
      message: String(error?.message || 'native execution failed').slice(0, 256),
      code: null,
    };
    // An actual workflow failure is terminal; retrying uncached side effects
    // automatically would defeat the explicit-cache contract.
    await store.fail({ executionId, workerId, epoch,
      error: failure, effectCount: runner.effectCount });
    return { status: 'failed', error: failure };
  } finally {
    await close();
    await runner.close();
    await artifact.cleanup();
  }
}
