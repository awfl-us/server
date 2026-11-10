// Explicit effect execution boundary. Never dispatches an unknown operation or
// retries an ambiguous external outcome automatically.
const validOperations = new Set(['http.get', 'http.post', 'http.patch', 'http.delete']);

export class NativeEffectDispatcher {
  constructor({ handlers, reconcile = {} }) {
    if (!handlers || typeof handlers !== 'object') throw new Error('handlers required');
    this.handlers = handlers;
    this.reconcile = reconcile;
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
    const key = `${executionId}:${effectId}`;
    // An effect prepared before a crash may already have reached the remote
    // system. Reconciliation is mandatory for an aged intent. No blind replay.
    if (state.epoch > 1 && intent.preparedAt < state.updatedAt) {
      const reconcile = this.reconcile[intent.operation];
      if (typeof reconcile !== 'function') {
        return { status: 'uncertain', effectId, reason: 'reconciliation required' };
      }
      const observed = await reconcile({ intent, idempotencyKey: key });
      if (observed === undefined) return { status: 'uncertain', effectId, reason: 'remote outcome unknown' };
      await store.recordEffect({ executionId, workerId, epoch, effectId, outcome: observed });
      return { status: 'reconciled', effectId, outcome: observed };
    }
    // Handlers must enforce their own network allowlist, auth and idempotency.
    // Any transport error leaves the prepared intent unresolved.
    const outcome = await this.handlers[intent.operation]({
      args: intent.args, idempotencyKey: key,
    });
    await store.recordEffect({ executionId, workerId, epoch, effectId, outcome });
    return { status: 'recorded', effectId, outcome };
  }
}
