// One process-local execution tree. A workflow.run effect invokes a published
// compiled child directly, not another Cloud Task or Firestore execution.
import { createHash } from 'node:crypto';
import { runNativeArtifact, buildNativeTrustedGlobals,
  createNativeStreamSession } from './runner.js';
import { tagNativeValue } from './executionStore.js';

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,99}$/;
const SLOT = /^s[0-9]+$/;
const MAX_DEPTH = 24;
const MAX_CHILD_CALLS = 4096;
const MAX_TRANSITIONS = 100_000;
const MAX_RELEASES = 64;
const MAX_STREAM_PROCESSES = 16; // per authenticated local execution tree

function checkedChildArgs(args, project, location) {
  if (!args || typeof args !== 'object' || Array.isArray(args) ||
      typeof args.workflow_id !== 'string' ||
      !Object.hasOwn(args, 'argument') ||
      (args.connector_params !== undefined &&
        (args.connector_params === null ||
         typeof args.connector_params !== 'object' ||
         args.connector_params.skip_polling !== false)) ||
      (args.project_id !== undefined && args.project_id !== project) ||
      (args.location !== undefined && args.location !== location)) {
    throw new Error('unsupported or unauthorized local workflow.run arguments');
  }

  // Scala-generated workflow names retain the deployment placeholder before
  // Google Workflows YAML substitution. Match the existing Workflows naming
  // convention when compiled Rust calls a local subworkflow instead.
  const raw = args.workflow_id;
  const marker = '${WORKFLOW_ENV}';
  const suffix = process.env.WORKFLOW_ENV || '';
  const name = raw.endsWith(marker)
    ? raw.slice(0, -marker.length) + suffix : raw;
  if (!NAME.test(name)) {
    throw new Error('unsupported or unauthorized local workflow.run arguments');
  }
  return name;
}

/** The same runner drives the parent and all synchronous children. */
export function createNativeLocalRunner({
  releases, handlers, rootExecutionId, identity, profiler = null,
  runArtifact = runNativeArtifact, onProgress = () => {},
  gcpProject = process.env.GCP_PROJECT || process.env.GCLOUD_PROJECT,
  region = process.env.WORKFLOWS_LOCATION || 'us-central1',
}) {
  const loaded = new Map(); // One pinned release and staged ELF per child name.
  // Stateless generated Rust code can serve multiple calls within one owner's
  // workflow tree. The session is never shared between distinct executions.
  const streams = new Map();
  let childCalls = 0, transitions = 0, effectCount = 0;
  let closed = false;
  const rootId = rootExecutionId;
  if (!/^native_[a-f0-9]{32}$/.test(rootId || '') ||
      !identity?.userId || !identity?.projectId) {
    throw new Error('local native runner requires trusted root execution context');
  }

  async function childRelease(name) {
    if (!releases?.active) throw new Error('local native release registry unavailable');
    if (!loaded.has(name)) {
      if (loaded.size >= MAX_RELEASES) throw new Error('local native release limit reached');
      const load = (async () => {
        const release = await releases.active(name);
        if (!release || release.protocolVersion !== 2 || release.parallelVersion === 1 ||
            !/^[a-f0-9]{64}$/.test(release.sha256 || '') ||
            !Array.isArray(release.allowedOperations) ||
            release.allowedOperations.includes('native.parallel')) {
          throw new Error('local child has no supported published native release');
        }
        const artifact = await releases.materialize(release.sha256);
        if (artifact.sha256 !== release.sha256) {
          await artifact.cleanup?.();
          throw new Error('local child artifact digest differs from release');
        }
        return { release, artifact };
      })();
      loaded.set(name, load);
      load.catch(() => { if (loaded.get(name) === load) loaded.delete(name); });
    }
    return loaded.get(name);
  }

  async function run({ workflowName, release, artifact, input, executionId,
                        globals = null, depth = 0, path = 'root' }) {
    if (closed || depth > MAX_DEPTH) throw new Error('native subworkflow depth limit reached');
    if (!NAME.test(workflowName || '') ||
        !Array.isArray(release.allowedOperations) ||
        release.allowedOperations.includes('native.parallel') ||
        artifact.sha256 !== release.sha256) {
      throw new Error('invalid local native release');
    }
    let continuation = null;
    while (true) {
      if (++transitions > MAX_TRANSITIONS) throw new Error('native execution transition limit reached');
      const payload = { protocol_version: 2, input,
        ...(globals && { trusted_globals: globals }),
        ...(continuation && { continuation }) };
      const invoke = () => {
        if (release.streamIpcVersion === 1) {
          let session = streams.get(release.sha256);
          if (!session && streams.size < MAX_STREAM_PROCESSES) {
            session = createNativeStreamSession({
              executable: artifact.executable, sha256: artifact.sha256, profiler,
            });
            streams.set(release.sha256, session);
          }
          // Explicit bound on process count: uncommon overflow goes through
          // the proven one-shot path, not an unbounded pool.
          if (session) return session.run(payload);
        }
        return runArtifact({
          executable: artifact.executable, sha256: artifact.sha256, profiler,
          input: payload,
        });
      };
      const response = profiler ? await profiler.measure('runner.transition', invoke)
        : await invoke();
      if (!response || response.protocol_version !== 2) {
        throw new Error('invalid native memory IPC version');
      }
      if (response.status === 'completed') return response.result;
      if (response.status === 'failed') {
        // Development diagnostic: expose the compiler's native failure,
        // without silently reducing it to a generic wrapper message.
        if (process.env.AWFL_NATIVE_LOCAL_TRACE === '1') {
          console.error('AWFL_NATIVE_CHILD_FAILURE', workflowName,
            JSON.stringify(response.error).slice(0, 1600));
        }
        const error = new Error('native workflow failed');
        error.nativeError = response.error;
        throw error;
      }
      if (response.status !== 'suspended' || !response.effect || !response.continuation) {
        throw new Error('invalid native memory suspension');
      }
      const effect = response.effect;
      const next = response.continuation;
      if (process.env.AWFL_NATIVE_LOCAL_TRACE === '1') {
        const fields = effect.operation === 'storage.object_get'
          ? { bucket:effect.args?.bucket, object:effect.args?.object }
          : effect.operation === 'workflow.run'
            ? { workflow_id:effect.args?.workflow_id }
            : {};
        console.error('AWFL_NATIVE_CHILD_EFFECT',
          JSON.stringify({workflowName,depth,operation:effect.operation,
            effectId:effect.effect_id,...fields}));
      }
      if (!release.allowedOperations.includes(effect.operation) ||
          effect.operation === 'native.parallel' ||
          (effect.operation !== 'workflow.run' &&
           typeof handlers[effect.operation] !== 'function')) {
        throw new Error('operation not allowed in local native workflow');
      }
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(effect.effect_id || '') ||
          !SLOT.test(effect.result_slot || '') ||
          !Number.isSafeInteger(next.next_step) || next.next_step < 0 ||
          !Array.isArray(next.frames) || next.frames.length !== 0 ||
          !next.slots || typeof next.slots !== 'object' || Array.isArray(next.slots)) {
        throw new Error('invalid local native continuation');
      }
      onProgress({ stage: 'effect', workflow: workflowName, effectCount,
        nodeId: effect.node_id, depth });
      try {
        const invokeEffect = async () => {
          if (effect.operation !== 'workflow.run') {
            return handlers[effect.operation]({ args: effect.args, identity,
              idempotencyKey: `${rootId}:${path}:${effect.effect_id}` });
          }
          const name = checkedChildArgs(effect.args, gcpProject, region);
          if (++childCalls > MAX_CHILD_CALLS || depth >= MAX_DEPTH) {
            throw new Error('local native subworkflow call limit reached');
          }
          const { release: child, artifact: childArtifact } = await childRelease(name);
          // A child gets its own virtual execution ID, without a Firestore
          // document. The authenticated user/project remain those of the root.
          const childId = 'native_' + createHash('sha256')
            .update(`${rootId}:${childCalls}`).digest('hex').slice(0, 32);
          const childGlobals = child.trustedGlobalsVersion === 1
            ? buildNativeTrustedGlobals({ state: { workflowName: name },
              executionId: childId, gcpProject, region }) : null;
          return run({ workflowName: name, release: child, artifact: childArtifact,
            input: effect.args.argument, executionId: childId, globals: childGlobals,
            depth: depth + 1, path: `${path}:${childCalls}` });
        };
        const outcome = profiler ? await profiler.measure('dispatcher.total', invokeEffect)
          : await invokeEffect();
        continuation = { ...next, slots: {
          ...next.slots, [effect.result_slot]: tagNativeValue(outcome),
        } };
      } catch (error) {
        if (process.env.AWFL_NATIVE_LOCAL_TRACE === '1') {
          console.error('AWFL_NATIVE_CHILD_EFFECT_ERROR',
            JSON.stringify({workflowName,operation:effect.operation,
              effectId:effect.effect_id,error:String(error?.message || error).slice(0, 700),
              nativeError:error?.nativeError}));
        }
        const onError = effect.on_error;
        if (!onError || !Number.isSafeInteger(onError.next_step) ||
            !SLOT.test(onError.error_slot || '')) throw error;
        const httpCode = error?.response?.status ?? error?.status ?? null;
        const failure = error?.nativeError ?? {
          message: Number.isSafeInteger(httpCode) ? `HTTP ${httpCode}` : 'native effect failed',
          code: Number.isSafeInteger(httpCode) && httpCode >= 400 && httpCode <= 599
            ? httpCode : null,
        };
        continuation = { ...next, next_step: onError.next_step,
          slots: { ...next.slots, [onError.error_slot]: tagNativeValue(failure) } };
      }
      effectCount++;
      onProgress({ stage: 'running', workflow: workflowName, effectCount, depth });
    }
  }

  return {
    run,
    get effectCount() { return effectCount; },
    get childCalls() { return childCalls; },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([...streams.values()].map(session => session.close()));
      streams.clear();
      await Promise.all([...loaded.values()].map(async promise => {
        const value = await promise.catch(() => null);
        await value?.artifact?.cleanup?.();
      }));
    },
  };
}
