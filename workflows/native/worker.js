// Jobs-only worker for one Cloud Tasks delivery. The public Workflows API
// authenticates the user and pins a GCS release before enqueuing the task.
// Cloud Run IAM authenticates the task's service identity. This process
// trusts only the persisted owner and artifact, not client-chosen binaries.
import { randomUUID } from 'node:crypto';
import { NativeEffectDispatcher } from './effectDispatcher.js';
import { NativeForkCoordinator } from './forkCoordinator.js';
import { executeNativeStep } from './runner.js';

// Shared by all descendants of one root execution. Fork coordinators do not
// hold a permit while waiting on their children, avoiding nested-fork deadlocks.
// Only native subprocess invocations and non-fork effects consume permits.
export function createExecutionBudget(maxActive = 8) {
  if (!Number.isSafeInteger(maxActive) || maxActive < 1) {
    throw new Error('native execution budget must have positive capacity');
  }
  let active = 0;
  const pending = [];
  return async work => {
    if (active < maxActive) {
      active++;
    } else {
      // Await a handed-off permit. The current holder keeps its reservation
      // until this waiter resumes, so a newcomer cannot steal the opening.
      await new Promise(resolve => pending.push(resolve));
    }
    try { return await work(); }
    finally {
      const next = pending.shift();
      if (next) next();
      else active--;
    }
  };
}

export async function runNativeWorkflow({
  store, releases, executionId, userId, projectId,
  handlers, workerId = 'worker_' + randomUUID().replaceAll('-', ''),
  maxTransitions = 120, sharedArtifact = null, parallelDepth = 0,
  executionBudget = null,
}) {
  const initial = await store.get(executionId);
  if (!initial || initial.userId !== userId ||
      initial.projectId !== projectId || !initial.workflowName ||
      initial.protocolVersion !== 2 || !Array.isArray(initial.allowedOperations)) {
    throw new Error('native execution does not match trusted Jobs task identity');
  }
  if (initial.status === 'completed') return initial.result;
  if (initial.status === 'failed') return { status: 'failed', error: initial.error };
  if (initial.status === 'cancelled') throw new Error('native execution cancelled');
  if (!Number.isSafeInteger(maxTransitions) || maxTransitions < 1 ||
      maxTransitions > 10000) throw new Error('invalid native transition budget');
  if (!Number.isSafeInteger(parallelDepth) || parallelDepth < 0 || parallelDepth > 3) {
    throw new Error('native fork depth outside permitted range');
  }
  const withBudget = executionBudget || createExecutionBudget(8);
  const artifact = sharedArtifact || await releases.materialize(initial.artifactSha256);
  if (artifact.sha256 !== initial.artifactSha256) {
    if (!sharedArtifact) await artifact.cleanup();
    throw new Error('native fork artifact digest differs from its parent');
  }
  try {
    // A fork is itself an authorized, journaled native effect. Running a
    // child re-enters this same owner-checked worker with an independently
    // persisted continuation and effect journal. No second interpreter.
    const runFork = async ({ args }) => {
      const parent = await store.get(executionId);
      const intent = parent?.pendingEffect;
      if (initial.parallelVersion !== 1 ||
          parent?.parallelVersion !== 1 ||
          !parent.allowedOperations?.includes('native.parallel') ||
          intent?.operation !== 'native.parallel' ||
          intent?.effectId !== args?.generation ||
          parallelDepth >= 3) {
        throw new Error('unauthorized or unsupported native parallel fork');
      }
      let heartbeatFailure = null, heartbeatPending = null;
      const heartbeat = typeof store.renew === 'function'
        ? setInterval(() => {
          if (heartbeatPending || heartbeatFailure) return;
          heartbeatPending = store.renew({
            executionId, workerId, epoch: parent.epoch,
            leaseMs: 120_000,
          }).catch(error => { heartbeatFailure = error; })
            .finally(() => { heartbeatPending = null; });
        }, 15_000)
        : null;
      heartbeat?.unref();
      const coordinator = new NativeForkCoordinator({
        store,
        maxConcurrency: 8,
        runLane: async ({ executionId: laneId }) => {
          // The parent still owns the durable fork intent while its child
          // runs. Extend the parent's fenced lease before starting a child.
          if (typeof store.renew === 'function') {
            await store.renew({
              executionId, workerId, epoch: parent.epoch,
              leaseMs: 120_000,
            });
          }
          return runNativeWorkflow({
            store, releases, executionId: laneId,
            userId, projectId, handlers,
            sharedArtifact: artifact, maxTransitions,
            parallelDepth: parallelDepth + 1,
            executionBudget: withBudget,
          });
        },
      });
      try {
        const results = await coordinator.execute({
          parent, effectId: intent.effectId, nodeId: intent.nodeId,
          generation: args.generation, lanes: args.lanes,
        });
        if (heartbeatPending) await heartbeatPending;
        if (heartbeatFailure) {
          throw new Error('native fork parent lost its fenced lease');
        }
        return results;
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        if (heartbeatPending) await heartbeatPending;
      }
    };
    const forkHandlers = initial.parallelVersion === 1 ?
      { ...handlers, 'native.parallel': runFork } : handlers;
    const dispatcher = new NativeEffectDispatcher({
      handlers: forkHandlers,
      reconcile: initial.parallelVersion === 1 ?
        { 'native.parallel': runFork } : {},
      authorizeExecution: async ({ userId: storedUser, projectId: storedProject }) => ({
        allowed: storedUser === userId && storedProject === projectId,
        userId: storedUser, projectId: storedProject,
      }),
    });
    for (let i = 0; i < maxTransitions; i++) {
      const outcome = await withBudget(() => executeNativeStep({
        store, executionId, workerId,
        executable: artifact.executable, sha256: artifact.sha256,
        allowedOperations: initial.allowedOperations,
      }));
      if (outcome.status === 'completed' || outcome.completed) {
        return outcome.result;
      }
      if (outcome.status === 'failed' || outcome.failed) {
        return { status: 'failed', error: outcome.error };
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
      const dispatch = () => dispatcher.dispatch({
        store, executionId, workerId, epoch: state.epoch,
        effectId: outcome.effectId,
      });
      const effect = state.pendingEffect?.operation === 'native.parallel'
        ? await dispatch() : await withBudget(dispatch);
      if (effect.status === 'uncertain') {
        // No automatic replay for an effect with an uncertain remote outcome.
        throw new Error('native effect reconciliation required');
      }
    }
    throw new Error('native execution transition budget exhausted');
  } finally {
    if (!sharedArtifact) await artifact.cleanup();
  }
}
