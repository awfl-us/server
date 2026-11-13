// A durable parent's workflow.run effect invokes a published non-parallel
// native child in-process. One authenticated Jobs request and one parent
// execution journal; no extra child Firestore doc or Cloud Task.
import { createHash } from 'node:crypto';
import { createNativeLocalRunner } from './localWorkflows.js';
import { buildNativeTrustedGlobals, runNativeArtifact } from './runner.js';

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,99}$/;
const MARKER = '${WORKFLOW_ENV}';

function childName(args, gcpProject, region) {
  if (!args || typeof args !== 'object' || Array.isArray(args) ||
      typeof args.workflow_id !== 'string' ||
      !Object.hasOwn(args, 'argument') ||
      (args.project_id !== undefined && args.project_id !== gcpProject) ||
      (args.location !== undefined && args.location !== region) ||
      (args.connector_params !== undefined &&
        (!args.connector_params || typeof args.connector_params !== 'object' ||
         typeof args.connector_params.skip_polling !== 'boolean'))) {
    throw new Error('unsupported or unauthorized durable workflow.run arguments');
  }
  const raw = args.workflow_id;
  const suffix = process.env.WORKFLOW_ENV || '';
  const name = raw.endsWith(MARKER) ? raw.slice(0, -MARKER.length) + suffix : raw;
  if (!NAME.test(name)) throw new Error('invalid durable subworkflow name');
  return name;
}

/** Create a root/fork-lane scoped handler for the native effect dispatcher.
 * Only an IAM-published non-parallel release is permitted for a local child.
 * External effects still use the Jobs IAM/OIDC handlers and authenticated owner.
 */
export function createDurableSubworkflowHandler({
  releases, handlers, executionId, userId, projectId,
  gcpProject = process.env.GCP_PROJECT || process.env.GCLOUD_PROJECT,
  region = process.env.WORKFLOWS_LOCATION || 'us-central1',
  runArtifact = runNativeArtifact, store, scheduleAsync,
}) {
  if (!releases?.active || !releases?.materialize ||
      !/^native_[a-f0-9]{32}$/.test(executionId || '') ||
      !userId || !projectId || !gcpProject) {
    throw new Error('trusted native child context required');
  }
  const runner = createNativeLocalRunner({
    releases, handlers, rootExecutionId: executionId, identity: { userId, projectId },
    gcpProject, region, runArtifact,
  });
  return {
    async run({ args, identity, idempotencyKey }) {
      if (identity?.userId !== userId || identity?.projectId !== projectId ||
          typeof idempotencyKey !== 'string' ||
          !idempotencyKey.startsWith(executionId + ':')) {
        throw new Error('durable child identity mismatch');
      }
      const name = childName(args, gcpProject, region);
      const detached = args.connector_params?.skip_polling === true;
      // Detached background work needs a persistent GKE Jobs worker in
      // production: Cloud Run can suspend CPU after the parent returns.
      if (detached && process.env.AWFL_NATIVE_DETACHED_GKE_ENABLED !== '1' &&
          process.env.AWFL_NATIVE_LOCAL_AUTH !== '1' &&
          process.env.NODE_ENV !== 'test') {
        throw new Error('native detached workflows require persistent GKE Jobs');
      }
      if (detached && (!store?.create || !store?.get ||
          typeof scheduleAsync !== 'function')) {
        throw new Error('native detached execution scheduler unavailable');
      }
      const release = await releases.active(name);
      if (!release || release.protocolVersion !== 2 ||
          (!detached && release.parallelVersion === 1) ||
          !/^[a-f0-9]{64}$/.test(release.sha256 || '') ||
          !Array.isArray(release.allowedOperations) ||
          (!detached && release.allowedOperations.includes('native.parallel'))) {
        throw new Error('native child has no supported published release');
      }
      if (detached) {
        // Stable per-parent-effect identity. Replayed dispatch cannot create a
        // duplicate independent workflow even across Jobs process restarts.
        const childExecutionId = 'native_' + createHash('sha256')
          .update(idempotencyKey + ':' + name).digest('hex').slice(0, 32);
        try {
          await store.create({
            executionId: childExecutionId, userId, projectId,
            workflowName: name, artifactSha256: release.sha256,
            protocolVersion: 2, allowedOperations: release.allowedOperations,
            ...(release.trustedGlobalsVersion === 1 && { trustedGlobalsVersion: 1 }),
            ...(release.parallelVersion === 1 && { parallelVersion: 1 }),
            asyncLaunch: true, input: args.argument,
          });
        } catch (error) {
          if (error.code !== 'CONFLICT') throw error;
          const existing = await store.get(childExecutionId);
          if (!existing || existing.userId !== userId ||
              existing.projectId !== projectId ||
              existing.workflowName !== name ||
              existing.artifactSha256 !== release.sha256 ||
              existing.protocolVersion !== 2 ||
              JSON.stringify(existing.input) !== JSON.stringify(args.argument)) {
            throw new Error('native detached launch idempotency conflict');
          }
        }
        // Only persist+enqueue before acknowledging the parent. Actual Rust
        // execution runs independently; no recursive wait or parent journal.
        scheduleAsync({ executionId: childExecutionId, userId, projectId });
        return { name: 'native/' + childExecutionId, state: 'ACTIVE' };
      }
      const artifact = await releases.materialize(release.sha256);
      if (artifact.sha256 !== release.sha256) {
        await artifact.cleanup?.();
        throw new Error('published native child artifact hash mismatch');
      }
      const childExecutionId = 'native_' + createHash('sha256')
        .update(idempotencyKey + ':' + name).digest('hex').slice(0, 32);
      const globals = release.trustedGlobalsVersion === 1
        ? buildNativeTrustedGlobals({
          state: { workflowName: name }, executionId: childExecutionId,
          gcpProject, region,
        }) : null;
      try {
        return await runner.run({
          workflowName: name, release, artifact, input: args.argument,
          executionId: childExecutionId, globals,
        });
      } finally {
        await artifact.cleanup?.();
      }
    },
    close: () => runner.close(),
  };
}
