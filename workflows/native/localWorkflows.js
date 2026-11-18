// One process-local execution tree. A workflow.run effect invokes a published
// compiled child directly, not another Cloud Task or Firestore execution.
import { createHash } from 'node:crypto';
import { runNativeArtifact, buildNativeTrustedGlobals,
  createNativeStreamSession } from './runner.js';
import { tagNativeValue } from './executionStore.js';
import { NativeConfirmedWorkflowFailure } from './effectErrors.js';
import { createMemoryParallelScheduler, NativeMemoryParallelStopped } from './memoryParallel.js';
import { resolveNativeProjectIdentity } from './projectScope.js';
import { diagnosticText, catchableEffectFailure } from './effectDiagnostics.js';

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
         typeof args.connector_params.skip_polling !== 'boolean')) ||
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
  runDetached = null,
  reportFailure = entry => console.error(JSON.stringify(entry)),
  reportEvent = entry => console.info(JSON.stringify(entry)),
  getProjectStorage,
  gcpProject = process.env.GCP_PROJECT || process.env.GCLOUD_PROJECT,
  region = process.env.WORKFLOWS_LOCATION || 'us-central1',
}) {
  const loaded = new Map(); // One pinned release and staged ELF per child name.
  // Stateless generated Rust code can serve multiple calls within one owner's
  // workflow tree. The session is never shared between distinct executions.
  const streams = new Map();
  const parallel = createMemoryParallelScheduler();
  let childCalls = 0, transitions = 0, effectCount = 0;
  let closed = false;
  const rootId = rootExecutionId;
  const emitEvent = entry => {
    try { reportEvent({ severity: 'INFO', ...entry }); } catch { /* best effort */ }
  };
  const emitFailure = entry => {
    // Diagnostics must never turn a handled workflow failure into an unhandled one.
    try { reportFailure({ severity: 'ERROR', ...entry }); } catch { /* logging is best effort */ }
  };
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
        if (!release || release.protocolVersion !== 2 ||
            !/^[a-f0-9]{64}$/.test(release.sha256 || '') ||
            !Array.isArray(release.allowedOperations) ||
            (release.parallelVersion === 1) !==
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
                        globals = null, depth = 0, path = 'root',
                        forkDepth = 0, initialContinuation = null,
                        shouldStop = () => false, scopedIdentity = identity,
                        parentExecutionId = null, parentEffectId = null }) {
    if (scopedIdentity?.userId !== identity.userId ||
        !scopedIdentity.projectId) {
      throw new Error('native child cannot change authenticated user');
    }
    // Even internal entrypoints must not accept an unverified project identity.
    scopedIdentity = await resolveNativeProjectIdentity(identity, {
      projectId: scopedIdentity.projectId, getStorage: getProjectStorage,
    });
    if (closed || depth > MAX_DEPTH) throw new Error('native subworkflow depth limit reached');
    if (!NAME.test(workflowName || '') ||
        !Array.isArray(release.allowedOperations) ||
        (release.parallelVersion === 1) !==
          release.allowedOperations.includes('native.parallel') ||
        artifact.sha256 !== release.sha256) {
      throw new Error('invalid local native release');
    }
    const workflowStartedAt = Date.now();
    emitEvent({ event: 'awfl_native_workflow_started', rootExecutionId: rootId,
      executionId, parentExecutionId, parentEffectId,
      projectId: scopedIdentity.projectId, workflow: workflowName, depth,
      executionMode: 'in_process' });
    let continuation = initialContinuation;
    // A static Rust effect ID can execute more than once inside a loop.
    // Per-lane ordinals are stable across replay and independent of sibling
    // interleaving, unlike a single global childCalls counter.
    const occurrences = new Map();
    while (true) {
      if (shouldStop()) throw new NativeMemoryParallelStopped();
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
      let response;
      try {
        response = profiler ? await profiler.measure('runner.transition', invoke)
          : await invoke();
      } catch (error) {
        emitFailure({ event: 'awfl_native_transition_failed',
          rootExecutionId: rootId, executionId, parentExecutionId, parentEffectId,
          projectId: scopedIdentity.projectId, workflow: workflowName, depth,
          errorName: diagnosticText(error?.name ?? 'Error', 120),
          errorCode: error?.code ?? error?.status ?? null,
          errorMessage: diagnosticText(error?.message ?? error),
          errorStack: typeof error?.stack === 'string'
            ? diagnosticText(error.stack, 4096) : null });
        throw error;
      }
      if (!response || response.protocol_version !== 2) {
        throw new Error('invalid native memory IPC version');
      }
      if (response.status === 'completed') {
        emitEvent({ event: 'awfl_native_workflow_completed',
          rootExecutionId: rootId, executionId, parentExecutionId, parentEffectId,
          projectId: scopedIdentity.projectId, workflow: workflowName, depth,
          durationMs: Date.now() - workflowStartedAt });
        return response.result;
      }
      if (response.status === 'failed') {
        emitFailure({
          event: 'awfl_native_workflow_failed', rootExecutionId: rootId,
          executionId, parentExecutionId, parentEffectId,
          projectId: scopedIdentity.projectId,
          workflow: workflowName, depth,
          errorCode: response.error?.code ?? null,
          errorMessage: diagnosticText(response.error?.message ?? response.error),
        });
        // Development diagnostic: expose the compiler's native failure,
        // without silently reducing it to a generic wrapper message.
        if (process.env.AWFL_NATIVE_LOCAL_TRACE === '1') {
          console.error('AWFL_NATIVE_CHILD_FAILURE', workflowName,
            JSON.stringify(response.error).slice(0, 1600));
        }
        throw new NativeConfirmedWorkflowFailure(response.error);
      }
      if (response.status !== 'suspended' || !response.effect || !response.continuation) {
        throw new Error('invalid native memory suspension');
      }
      const effect = response.effect;
      const next = response.continuation;
      const ordinal = (occurrences.get(effect.effect_id) || 0) + 1;
      occurrences.set(effect.effect_id, ordinal);
      const effectPath = path + ':v' + ordinal;
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
          (effect.operation === 'native.parallel' && release.parallelVersion !== 1) ||
          (effect.operation !== 'workflow.run' &&
           effect.operation !== 'native.parallel' &&
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
      const startedAt = Date.now();
      emitEvent({ event: 'awfl_native_effect_started',
        rootExecutionId: rootId, executionId, parentExecutionId, parentEffectId,
        projectId: scopedIdentity.projectId, workflow: workflowName, depth,
        operation: effect.operation, effectId: effect.effect_id,
        nodeId: effect.node_id, ordinal });
      try {
        const invokeEffect = async () => {
          if (effect.operation === 'native.parallel') {
            return parallel.runFork({
              effect: { ...effect, args: {
                ...effect.args,
                // Disambiguate re-entered forks inside loops.
                generation: effect.args?.generation + ':n' + ordinal,
              } },
              executionId, forkDepth, shouldStop,
              runLane: ({ index, entry, slots, laneId,
                          forkDepth: nextDepth, shouldStop: laneStopped }) =>
                run({ workflowName, release, artifact, input,
                  executionId: laneId, globals, depth,
                  scopedIdentity,
                  path: path + ':lane:' + laneId.slice(7),
                  forkDepth: nextDepth, shouldStop: laneStopped,
                  initialContinuation: { next_step: entry, slots, frames: [] },
                  parentExecutionId: executionId, parentEffectId: effect.effect_id,
                }),
            });
          }
          if (effect.operation !== 'workflow.run') {
            return parallel.withEffectPermit(() =>
              handlers[effect.operation]({
                args: effect.args, identity: scopedIdentity,
                idempotencyKey: rootId + ':' + effectPath + ':' + effect.effect_id,
              }), shouldStop);
          }
          const name = checkedChildArgs(effect.args, gcpProject, region);
          const env = effect.args.argument?.env;
          const childIdentity = await resolveNativeProjectIdentity(scopedIdentity, {
            projectId: env?.projectId, userId: env?.userId,
            getStorage: getProjectStorage,
          });
          if (effect.args.connector_params?.skip_polling === true) {
            if (typeof runDetached !== 'function') {
              throw new Error('memory detached scheduler unavailable');
            }
            return runDetached({
              name, args: effect.args, path: effectPath, effectId: effect.effect_id,
              identity: childIdentity,
            });
          }
          if (++childCalls > MAX_CHILD_CALLS || depth >= MAX_DEPTH) {
            throw new Error('local native subworkflow call limit reached');
          }
          const { release: child, artifact: childArtifact } = await childRelease(name);
          const childId = 'native_' + createHash('sha256')
            .update(rootId + ':' + effectPath + ':' + effect.effect_id)
            .digest('hex').slice(0, 32);
          const childGlobals = child.trustedGlobalsVersion === 1
            ? buildNativeTrustedGlobals({
              state: { workflowName: name }, executionId: childId,
              gcpProject, region,
            }) : null;
          return run({
            workflowName: name, release: child, artifact: childArtifact,
            input: effect.args.argument, executionId: childId,
            scopedIdentity: childIdentity,
            globals: childGlobals, depth: depth + 1,
            path: effectPath + ':call:' + effect.effect_id, forkDepth, shouldStop,
            parentExecutionId: executionId, parentEffectId: effect.effect_id,
          });
        };
        const outcome = profiler ? await profiler.measure('dispatcher.total', invokeEffect)
          : await invokeEffect();
        continuation = { ...next, slots: {
          ...next.slots, [effect.result_slot]: tagNativeValue(outcome),
        } };
        emitEvent({ event: 'awfl_native_effect_completed',
          rootExecutionId: rootId, executionId, parentExecutionId, parentEffectId,
          projectId: scopedIdentity.projectId, workflow: workflowName, depth,
          operation: effect.operation, effectId: effect.effect_id,
          nodeId: effect.node_id, ordinal, durationMs: Date.now() - startedAt });
      } catch (error) {
        if (shouldStop() || error instanceof NativeMemoryParallelStopped) throw error;
        const underlying = error?.nativeError ?? error;
        emitFailure({
          event: 'awfl_native_effect_failed', rootExecutionId: rootId,
          executionId, parentExecutionId, parentEffectId,
          projectId: scopedIdentity.projectId,
          workflow: workflowName, depth, operation: effect.operation,
          effectId: effect.effect_id, nodeId: effect.node_id, ordinal,
          durationMs: Date.now() - startedAt,
          errorName: diagnosticText(error?.name ?? 'Error', 120),
          errorCode: underlying?.code ?? error?.response?.status ??
            error?.status ?? null,
          errorMessage: diagnosticText(underlying?.message ?? error?.message ?? error),
          errorStack: typeof error?.stack === 'string'
            ? diagnosticText(error.stack, 4096) : null,
        });
        // Unknown workflow.run/parallel outcomes still propagate for reconciliation;
        // they must nonetheless leave an actionable diagnostic in Cloud Logging.
        if ((effect.operation === 'native.parallel' ||
             effect.operation === 'workflow.run') &&
            !(error instanceof NativeConfirmedWorkflowFailure)) throw error;
        if (process.env.AWFL_NATIVE_LOCAL_TRACE === '1') {
          console.error('AWFL_NATIVE_CHILD_EFFECT_ERROR',
            JSON.stringify({workflowName,operation:effect.operation,
              effectId:effect.effect_id,error:String(error?.message || error).slice(0, 700),
              nativeError:error?.nativeError}));
        }
        const onError = effect.on_error;
        if (!onError || !Number.isSafeInteger(onError.next_step) ||
            !SLOT.test(onError.error_slot || '')) throw error;
        const failure = catchableEffectFailure(error, effect.operation, effect.effect_id);
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
    get parallelLaneCount() { return parallel.totalLanes; },
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
