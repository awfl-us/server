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
         args.connector_params.skip_polling !== false))) {
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
  runArtifact = runNativeArtifact,
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
      const release = await releases.active(name);
      if (!release || release.protocolVersion !== 2 ||
          release.parallelVersion === 1 ||
          !Array.isArray(release.allowedOperations) ||
          release.allowedOperations.includes('native.parallel')) {
        throw new Error('native child has no supported published release');
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
