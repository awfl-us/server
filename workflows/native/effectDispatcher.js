import { NativeConfirmedHttpFailure, NativeConfirmedWorkflowFailure } from './effectErrors.js';
import { NativeConfirmedParallelFailure } from './forkCoordinator.js';
import { diagnosticText } from './effectDiagnostics.js';
// Explicit effect execution boundary. Never dispatches an unknown operation or
// retries an ambiguous external outcome automatically.
const validOperations = new Set(['http.get', 'http.post', 'http.patch', 'http.delete', 'log.write', 'native.parallel', 'workflow.run', 'storage.object_get', 'callback.create', 'callback.await']);

export class NativeEffectDispatcher {
  constructor({ handlers, reconcile = {}, authorizeExecution,
                reportFailure = entry => console.error(JSON.stringify(entry)) }) {
    if (!handlers || typeof handlers !== 'object') throw new Error('handlers required');
    if (typeof authorizeExecution !== 'function') {
      throw new Error('native effect dispatcher requires an authorization policy');
    }
    this.handlers = handlers;
    this.reconcile = reconcile;
    this.authorizeExecution = authorizeExecution;
    this.reportFailure = reportFailure;
  }

  async dispatch({ store, executionId, workerId, epoch, effectId,
                   preparedState = null }) {
    // A freshly committed prepareEffect result is already owner/epoch-fenced.
    // Retain the independent post-authorization read below, which detects
    // cancellations, takeovers and changed effect intents before HTTP calls.
    const state = preparedState || await store.get(executionId);
    if (!state) throw new Error('execution not found');
    if (state.owner !== workerId || state.epoch !== epoch || state.leaseUntil <= Date.now()) {
      throw new Error('worker lease invalid');
    }
    const intent = state.pendingEffect;
    if (!intent || intent.effectId !== effectId) throw new Error('effect not pending');
    if (!validOperations.has(intent.operation) || typeof this.handlers[intent.operation] !== 'function') {
      throw new Error(`effect operation not allowed: ${intent.operation}`);
    }
    // Authentication and tenant/project authorization live outside the
    // compiled binary. No handler (including reconciliation) is reached
    // until a trusted policy explicitly authorizes this stored owner.
    const authorization = await this.authorizeExecution({
      executionId, userId: state.userId, projectId: state.projectId,
      workerId, operation: intent.operation, effectId,
    });
    if (authorization?.allowed !== true ||
        authorization.userId !== state.userId ||
        authorization.projectId !== state.projectId ||
        typeof state.userId !== 'string' || !state.userId ||
        typeof state.projectId !== 'string' || !state.projectId) {
      throw new Error('native effect execution not authorized');
    }
    // Do not forward arbitrary policy-returned fields (especially privileged
    // tokens) into an operation handler.
    const identity = Object.freeze({
      userId: state.userId, projectId: state.projectId,
    });
    // Recheck the lease and intent after the asynchronous permission check.
    // This narrows the cancellation/takeover race before external dispatch.
    const current = await store.get(executionId);
    if (!current || current.owner !== workerId || current.epoch !== epoch ||
        current.leaseUntil <= Date.now() ||
        current.pendingEffect?.effectId !== effectId ||
        current.pendingEffect?.fingerprint !== intent.fingerprint ||
        current.status === 'cancelled') {
      throw new Error('native effect lease or intent changed during authorization');
    }
    const key = `${executionId}:${effectId}`;
    const withState = (result, persisted) => preparedState && persisted &&
      typeof persisted === 'object' ? { ...result, state: persisted } : result;
    const recordConfirmed = async error => {
      const http = error instanceof NativeConfirmedHttpFailure;
      const fork = error instanceof NativeConfirmedParallelFailure;
      const child = error instanceof NativeConfirmedWorkflowFailure;
      if (!http && !fork && !child) throw error;
      const failure = {
        message: error.message, code: http ? error.status : null,
      };
      if (intent.onError) {
        if (typeof store.recordEffectFailure !== 'function') throw error;
        const persisted = await store.recordEffectFailure({
          executionId, workerId, epoch, effectId, failure,
        });
        return withState({ status: 'failed_recorded', effectId, failure }, persisted);
      }
      if ((fork || child) && typeof store.failPendingConfirmedEffect === 'function') {
        const persisted = await store.failPendingConfirmedEffect({
          executionId, workerId, epoch, effectId, error: failure,
          operation: fork ? 'native.parallel' : 'workflow.run',
        });
        return withState({ status: 'failed_recorded', effectId, failure }, persisted);
      }
      // Preserve the old fork-specific store contract for callers still
      // implementing it, without weakening the confirmed-failure check.
      if (fork && typeof store.failPendingParallel === 'function') {
        const persisted = await store.failPendingParallel({
          executionId, workerId, epoch, effectId, error: failure,
        });
        return withState({ status: 'failed_recorded', effectId, failure }, persisted);
      }
      // Unhandled confirmed HTTP failures keep their previous behavior.
      throw error;
    };
    const logFailure = (error, phase) => {
      try {
        this.reportFailure({
          severity: 'ERROR', event: 'awfl_native_effect_failed',
          executionId, projectId: state.projectId, workflow: state.workflowName ?? null,
          operation: intent.operation, effectId, nodeId: intent.nodeId ?? null, phase,
          errorName: diagnosticText(error?.name ?? 'Error', 120),
          errorCode: error?.response?.status ?? error?.status ?? error?.code ?? null,
          errorMessage: diagnosticText(error?.message ?? error),
          errorStack: typeof error?.stack === 'string'
            ? diagnosticText(error.stack, 4096) : null,
        });
      } catch { /* failed logging must not change native effects */ }
    };
    // An effect prepared before a crash may already have reached the remote
    // system. Reconciliation is mandatory for an aged intent. No blind replay.
    if (state.epoch > 1 && intent.preparedAt < state.updatedAt) {
      const reconcile = this.reconcile[intent.operation];
      if (typeof reconcile !== 'function') {
        return { status: 'uncertain', effectId, reason: 'reconciliation required' };
      }
      try {
        const observed = await reconcile({
          args: intent.args, intent, idempotencyKey: key, identity,
          trustedCallbackAncestors: current.detachedAncestors ?? [],
        });
        if (observed === undefined) {
          return { status: 'uncertain', effectId, reason: 'remote outcome unknown' };
        }
        const persisted = await store.recordEffect({ executionId, workerId, epoch,
          effectId, outcome: observed });
        return withState({ status: 'reconciled', effectId, outcome: observed }, persisted);
      } catch (error) {
        // Previous remote outcome may still be unknown; preserve reconciliation policy.
        logFailure(error, 'reconcile');
        return recordConfirmed(error);
      }
    }
    // Handlers must enforce their own network allowlist, auth and idempotency.
    // Any transport error leaves the prepared intent unresolved.
    let outcome;
    try {
      outcome = await this.handlers[intent.operation]({
        args: intent.args, idempotencyKey: key, identity,
        trustedCallbackAncestors: current.detachedAncestors ?? [],
      });
    } catch (error) {
      // Log before the dispatcher may leave the effect unresolved. In particular,
      // preflight callback authorization failures never reach HTTP access logs.
      logFailure(error, 'dispatch');
      // A confirmed child terminal failure is safe to catch (or to fail an
      // uncaught parent fork). Unknown/transport outcomes remain unresolved.
      return recordConfirmed(error);
    }
    const persisted = await store.recordEffect({ executionId, workerId, epoch,
      effectId, outcome });
    return withState({ status: 'recorded', effectId, outcome }, persisted);
  }
}
