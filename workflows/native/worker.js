// Jobs-only worker for one Cloud Tasks delivery. The public Workflows API
// authenticates the user and pins a GCS release before enqueuing the task.
// Cloud Run IAM authenticates the task's service identity. This process
// trusts only the persisted owner and artifact, not client-chosen binaries.
import { randomUUID } from 'node:crypto';
import { NativeEffectDispatcher } from './effectDispatcher.js';
import { executeNativeStep } from './runner.js';

export async function runNativeWorkflow({
  store, releases, executionId, userId, projectId,
  handlers, workerId = 'worker_' + randomUUID().replaceAll('-', ''),
  maxTransitions = 120,
}) {
  const initial = await store.get(executionId);
  if (!initial || initial.userId !== userId ||
      initial.projectId !== projectId || !initial.workflowName ||
      initial.protocolVersion !== 2 || !Array.isArray(initial.allowedOperations)) {
    throw new Error('native execution does not match trusted Jobs task identity');
  }
  if (initial.status === 'completed') return initial.result;
  if (initial.status === 'cancelled') throw new Error('native execution cancelled');
  if (!Number.isSafeInteger(maxTransitions) || maxTransitions < 1 ||
      maxTransitions > 10000) throw new Error('invalid native transition budget');
  const artifact = await releases.materialize(initial.artifactSha256);
  try {
    const dispatcher = new NativeEffectDispatcher({
      handlers,
      authorizeExecution: async ({ userId: storedUser, projectId: storedProject }) => ({
        allowed: storedUser === userId && storedProject === projectId,
        userId: storedUser, projectId: storedProject,
      }),
    });
    for (let i = 0; i < maxTransitions; i++) {
      const outcome = await executeNativeStep({
        store, executionId, workerId,
        executable: artifact.executable, sha256: artifact.sha256,
        allowedOperations: initial.allowedOperations,
      });
      if (outcome.status === 'completed' || outcome.completed) {
        return outcome.result;
      }
      if (outcome.cancelled) throw new Error('native execution cancelled');
      if (outcome.status !== 'waiting_effect') {
        throw new Error('unrecognized native execution state');
      }
      const state = await store.get(executionId);
      if (state.userId !== userId || state.projectId !== projectId) {
        throw new Error('native execution owner changed');
      }
      if (typeof store.renew === 'function') {
        await store.renew({
          executionId, workerId, epoch: state.epoch, leaseMs: 60_000,
        });
      }
      const effect = await dispatcher.dispatch({
        store, executionId, workerId, epoch: state.epoch,
        effectId: outcome.effectId,
      });
      if (effect.status === 'uncertain') {
        // No automatic replay for an effect with an uncertain remote outcome.
        throw new Error('native effect reconciliation required');
      }
    }
    throw new Error('native execution transition budget exhausted');
  } finally {
    await artifact.cleanup();
  }
}
