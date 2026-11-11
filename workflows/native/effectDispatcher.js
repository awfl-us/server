import { NativeConfirmedHttpFailure } from './effectErrors.js';
// Explicit effect execution boundary. Never dispatches an unknown operation or
// retries an ambiguous external outcome automatically.
const validOperations = new Set(['http.get', 'http.post', 'http.patch', 'http.delete']);

export class NativeEffectDispatcher {
  constructor({ handlers, reconcile = {}, authorizeExecution }) {
    if (!handlers || typeof handlers !== 'object') throw new Error('handlers required');
    if (typeof authorizeExecution !== 'function') {
      throw new Error('native effect dispatcher requires an authorization policy');
    }
    this.handlers = handlers;
    this.reconcile = reconcile;
    this.authorizeExecution = authorizeExecution;
  }

  async dispatch({ store, executionId, workerId, epoch, effectId }) {
    const state = await store.get(executionId);
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
    // An effect prepared before a crash may already have reached the remote
    // system. Reconciliation is mandatory for an aged intent. No blind replay.
    if (state.epoch > 1 && intent.preparedAt < state.updatedAt) {
      const reconcile = this.reconcile[intent.operation];
      if (typeof reconcile !== 'function') {
        return { status: 'uncertain', effectId, reason: 'reconciliation required' };
      }
      const observed = await reconcile({ intent, idempotencyKey: key, identity });
      if (observed === undefined) return { status: 'uncertain', effectId, reason: 'remote outcome unknown' };
      await store.recordEffect({ executionId, workerId, epoch, effectId, outcome: observed });
      return { status: 'reconciled', effectId, outcome: observed };
    }
    // Handlers must enforce their own network allowlist, auth and idempotency.
    // Any transport error leaves the prepared intent unresolved.
    let outcome;
    try {
      outcome = await this.handlers[intent.operation]({
        args: intent.args, idempotencyKey: key, identity,
      });
    } catch (error) {
      if (!(error instanceof NativeConfirmedHttpFailure) ||
          !intent.onError || typeof store.recordEffectFailure !== 'function') throw error;
      // Only a definitive HTTP response with a compiled catch edge is safe
      // to journal. Transport/reconciliation/policy errors stay unresolved.
      const failure = { message: error.message, code: error.status };
      await store.recordEffectFailure({ executionId, workerId, epoch, effectId,
        failure });
      return { status: 'failed_recorded', effectId, failure };
    }
    await store.recordEffect({ executionId, workerId, epoch, effectId, outcome });
    return { status: 'recorded', effectId, outcome };
  }
}
