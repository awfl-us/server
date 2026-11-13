// Pure server-local implementation of the current DSL's `Log` effect.
// Kept separate from Jobs IAM/OIDC HTTP clients for narrow, dependency-free
// testing and to make it impossible to turn a log into a network request.
export function createNativeLogEffectHandler(logger) {
  if (typeof logger?.info !== 'function') {
    throw new Error('native log effect requires a trusted structured logger');
  }
  return async ({ args, identity, idempotencyKey }) => {
    if (!args || typeof args !== 'object' || Array.isArray(args) ||
        Object.getPrototypeOf(args) !== Object.prototype ||
        Object.keys(args).length !== 1 || typeof args.text !== 'string' ||
        !args.text || Buffer.byteLength(args.text) > 4096 ||
        typeof identity?.userId !== 'string' || !identity.userId ||
        typeof identity?.projectId !== 'string' || !identity.projectId ||
        typeof idempotencyKey !== 'string' ||
        Buffer.byteLength(idempotencyKey) > 512 ||
        !/^[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)+$/.test(idempotencyKey)) {
      throw new Error('invalid authenticated native log effect');
    }
    // A stable ID lets downstream logging deduplicate entries; the
    // server's effect journal, not log ingestion, controls workflow replay.
    logger.info({
      severity: 'INFO',
      message: args.text,
      'logging.googleapis.com/insertId': idempotencyKey,
      nativeWorkflow: { userId: identity.userId, projectId: identity.projectId },
    });
    return null;  // Current DSL Log is a Call[_, Nothing].
  };
}
