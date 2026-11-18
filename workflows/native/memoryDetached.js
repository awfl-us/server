// A memory-root workflow can launch an independent detached child. Unlike
// in-memory parallel lanes, a detached workflow outlives its parent and
// therefore has its *own* durable provider-neutral root record and GKE scheduling.
// Keep the same pinned-id and replay contract as the durable launcher.
import { createHash } from 'node:crypto';
import { nativeAsyncSchedulerFor } from './worker.js';

const SHA = /^[a-f0-9]{64}$/;

export function createMemoryDetachedLauncher({
  store, releases, handlers, executionId, userId, projectId,
  asyncScheduler = null,
}) {
  if (!store?.create || !store?.get || !releases?.active ||
      !/^native_[a-f0-9]{32}$/.test(executionId || '') ||
      !userId || !projectId) {
    throw new Error('trusted memory detached launch context required');
  }

  return async ({ name, args, path, effectId, identity: childIdentity = { userId, projectId } }) => {
    if (typeof path !== 'string' || !path ||
        !/^[A-Za-z0-9_-]{1,120}$/.test(effectId || '') ||
        !args || !Object.hasOwn(args, 'argument')) {
      throw new Error('invalid memory detached call');
    }
    if (process.env.AWFL_NATIVE_DETACHED_GKE_ENABLED !== '1' &&
        process.env.AWFL_NATIVE_LOCAL_AUTH !== '1' &&
        process.env.NODE_ENV !== 'test') {
      throw new Error('native detached workflows require persistent GKE Jobs');
    }
    const release = await releases.active(name);
    if (!release || release.protocolVersion !== 2 ||
        !SHA.test(release.sha256 || '') ||
        !Array.isArray(release.allowedOperations) ||
        (release.parallelVersion === 1) !==
          release.allowedOperations.includes('native.parallel')) {
      throw new Error('memory detached child has no published native release');
    }

    // Stable across restart/branch execution order. Unlike childCalls,
    // path contains the input-index and parent fork generation.
    if (childIdentity.userId !== userId || !childIdentity.projectId) {
      throw new Error('native detached child identity mismatch');
    }
    const childProjectId = childIdentity.projectId;
    const childId = 'native_' + createHash('sha256')
      .update(JSON.stringify([executionId, path, effectId, name]))
      .digest('hex').slice(0, 32);
    try {
      await store.create({
        executionId: childId, userId, projectId: childProjectId,
        workflowName: name, artifactSha256: release.sha256,
        protocolVersion: 2, allowedOperations: release.allowedOperations,
        ...(release.trustedGlobalsVersion === 1 && { trustedGlobalsVersion: 1 }),
        ...(release.streamIpcVersion === 1 && { streamIpcVersion: 1 }),
        ...(release.parallelVersion === 1 && { parallelVersion: 1 }),
        asyncLaunch: true, detachedParentExecutionId: executionId, input: args.argument,
      });
    } catch (error) {
      if (error.code !== 'CONFLICT' && error.code !== 'ALREADY_EXISTS') throw error;
      const existing = await store.get(childId);
      if (!existing || existing.userId !== userId ||
          existing.projectId !== childProjectId ||
          existing.workflowName !== name ||
          existing.artifactSha256 !== release.sha256 ||
          existing.protocolVersion !== 2 ||
          existing.detachedParentExecutionId !== executionId ||
          JSON.stringify(existing.input) !== JSON.stringify(args.argument)) {
        throw new Error('memory detached child idempotency conflict');
      }
    }

    const scheduler = asyncScheduler ||
      nativeAsyncSchedulerFor({ store, releases, handlers });
    if (typeof scheduler?.enqueue !== 'function') {
      throw new Error('native detached scheduler unavailable');
    }
    scheduler.enqueue({ executionId: childId, userId, projectId: childProjectId });
    return { name: 'native/' + childId, state: 'ACTIVE' };
  };
}
