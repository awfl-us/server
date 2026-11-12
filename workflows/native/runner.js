// Opt-in native artifact runner. The registered wrapper resolves signed,
// SHA-256-pinned artifacts. The raw entry point is for trusted test callers.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_INPUT = 1024 * 1024;
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_EXECUTABLE = 64 * 1024 * 1024;

export async function runNativeArtifact({ executable, sha256, input, timeoutMs = 30_000 }) {
  if (typeof executable !== 'string' || !executable.startsWith('/') ||
      !/^[a-f0-9]{64}$/.test(sha256 || '')) throw new Error('trusted absolute executable and SHA-256 required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error('invalid timeout');
  // Open the source without following a final-component symlink; hash the
  // opened descriptor, not a path that may be swapped mid-read. The private
  // staged copy eliminates the check-then-execute filesystem race.
  const handle = await open(executable, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_EXECUTABLE) {
      throw new Error('invalid native executable type or size');
    }
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('artifact SHA-256 mismatch');
  const payload = JSON.stringify(input);
  if (payload === undefined) throw new Error('native input must be JSON');
  if (Buffer.byteLength(payload) > MAX_INPUT) throw new Error('native input too large');
  const stage = await mkdtemp(join(tmpdir(), 'awfl-native-exec-'));
  try {
    const stagedExecutable = join(stage, 'artifact');
    await writeFile(stagedExecutable, bytes, { flag: 'wx', mode: 0o600 });
    await chmod(stagedExecutable, 0o500);
    return await new Promise((resolve, reject) => {
      // No GCP credentials, API keys, injected token locations, or caller env.
      // This is defense in depth, NOT a container/namespace security sandbox.
      const child = spawn(stagedExecutable, [], {
        stdio: ['pipe', 'pipe', 'pipe'], shell: false, cwd: stage,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      });
      let stdout = '', stderr = '', outputBytes = 0, settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error('native execution timeout'));
      }, timeoutMs);
      child.on('error', error => finish(error));
      child.stdout.on('data', chunk => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT) {
          child.kill('SIGKILL');
          finish(new Error('native output too large'));
        } else stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', chunk => {
        if (stderr.length < 4096) stderr += chunk.toString('utf8').slice(0, 4096 - stderr.length);
      });
      child.on('close', code => {
        if (settled) return;
        if (code !== 0) return finish(new Error(`native process exited ${code}: ${stderr}`));
        try { finish(null, JSON.parse(stdout)); } catch { finish(new Error('invalid native JSON result')); }
      });
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') finish(error); });
      child.stdin.end(payload);
    });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function executePureNative({ store, executionId, workerId, executable, sha256, timeoutMs }) {
  const leaseMs = Math.max(60_000, (timeoutMs ?? 30_000) + 10_000);
  const state = await store.claim({ executionId, workerId, leaseMs });
  if (state.completed || state.cancelled || state.failed) return state;
  if (state.artifactSha256 !== sha256) throw new Error('pinned artifact mismatch');
  if (state.pendingEffect || state.checkpoint) throw new Error('continuation protocol not implemented for this artifact');
  const result = await runNativeArtifact({ executable, sha256, input: state.input, timeoutMs });
  await store.complete({ executionId, workerId, epoch: state.epoch, result });
  return { completed: true, result };
}

// The native binary is not an authentication boundary. Only the IAM-protected
// Jobs worker may construct this envelope, from a persisted execution and
// server-owned GCP deployment configuration. AWFL's tenant projectId and
// caller-supplied input.env are intentionally NOT used for GCP project identity.
export function buildNativeTrustedGlobals({
  state, executionId,
  gcpProject = process.env.GCP_PROJECT || process.env.GCLOUD_PROJECT,
  region = process.env.WORKFLOWS_LOCATION || 'us-central1',
}) {
  if (!state?.workflowName || !gcpProject) return null; // Legacy/pure tests.
  if (state.executionId && state.executionId !== executionId) {
    throw new Error('persisted native execution identity mismatch');
  }
  if (typeof executionId !== 'string' || !/^native_[a-f0-9]{32}$/.test(executionId) ||
      typeof gcpProject !== 'string' ||
      !/^[a-z][a-z0-9-]{2,62}$/.test(gcpProject) ||
      typeof region !== 'string' || !/^[a-z0-9-]{2,63}$/.test(region) ||
      typeof state.workflowName !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(state.workflowName)) {
    throw new Error('invalid trusted native execution context');
  }
  return {
    GOOGLE_CLOUD_WORKFLOW_ID: state.workflowName,
    GOOGLE_CLOUD_WORKFLOW_EXECUTION_ID:
      state.forkLane?.rootExecutionId || executionId,
    GOOGLE_CLOUD_PROJECT_ID: gcpProject,
    GOOGLE_CLOUD_LOCATION: region,
  };
}

// One opt-in native IPC transition per claim. The executable is trusted and
// hash-verified, but it never performs external effects. A suspended intent is
// committed before an independent authenticated dispatcher can send it.
// This path is NOT connected to the common production launcher.
export async function executeNativeStep({ store, executionId, workerId, executable, sha256,
                                          timeoutMs, allowedOperations, gcpProject, region }) {
  const leaseMs = Math.max(60_000, (timeoutMs ?? 30_000) + 10_000);
  const state = await store.claim({ executionId, workerId, leaseMs });
  if (state.completed || state.cancelled || state.failed) return state;
  if (state.artifactSha256 !== sha256) throw new Error('pinned artifact mismatch');
  const protocolVersion = state.protocolVersion || 1;
  if (protocolVersion !== 1 && protocolVersion !== 2) throw new Error('unsupported native artifact protocol');
  if (state.pendingEffect) {
    return { status: 'waiting_effect', effectId: state.pendingEffect.effectId };
  }
  const continuation = state.checkpoint && {
    next_step: state.checkpoint.next_step,
    slots: state.checkpoint.slots,
    frames: state.checkpoint.frames,
  };
  if (state.checkpoint && (!Number.isSafeInteger(continuation.next_step) ||
      !Array.isArray(continuation.frames))) {
    throw new Error('invalid native continuation checkpoint');
  }
  // Old ABI-3/protocol-v2 binaries reject unknown JSON fields. Only
  // IAM-published releases that explicitly declare global support receive
  // this optional envelope; the capability is pinned with the execution.
  const trustedGlobals = protocolVersion === 2 && state.trustedGlobalsVersion === 1
    ? buildNativeTrustedGlobals({ state, executionId, gcpProject, region })
    : null;
  const response = await runNativeArtifact({
    executable, sha256, timeoutMs,
    input: { protocol_version: protocolVersion, input: state.input,
      ...(trustedGlobals && { trusted_globals: trustedGlobals }),
      ...(continuation && { continuation }) },
  });
  if (!response || response.protocol_version !== protocolVersion) {
    throw new Error('native IPC version mismatch');
  }
  if (response.status === 'failed') {
    if (!Object.hasOwn(response, 'error') || state.pendingEffect) {
      throw new Error('invalid native terminal error');
    }
    await store.fail({ executionId, workerId, epoch: state.epoch, error: response.error });
    return { status: 'failed', error: response.error };
  }
  if (response.status === 'completed') {
    if (!Object.hasOwn(response, 'result')) throw new Error('native completion missing result');
    await store.complete({ executionId, workerId, epoch: state.epoch, result: response.result });
    return { status: 'completed', result: response.result };
  }
  if (response.status !== 'suspended') throw new Error('invalid native IPC status');
  const { effect, continuation: next } = response;
  const onError = effect?.on_error;
  if (onError !== undefined && onError !== null &&
      (protocolVersion !== 2 || !Number.isSafeInteger(onError.next_step) ||
       onError.next_step < 0 || !/^s[0-9]+$/.test(onError.error_slot || '') ||
       Object.keys(onError).some(k => !['next_step', 'error_slot'].includes(k)))) {
    throw new Error('invalid native compiled effect error edge');
  }
  if (allowedOperations && !allowedOperations.includes(effect?.operation)) {
    throw new Error('operation outside approved native artifact capabilities');
  }
  if (!effect || !/^[A-Za-z0-9_-]{1,120}$/.test(effect.effect_id || '') ||
      !/^[A-Za-z0-9_.-]{1,120}$/.test(effect.node_id || '') ||
      !/^s[0-9]+$/.test(effect.result_slot || '') ||
      typeof effect.operation !== 'string' ||
      !next || !Number.isSafeInteger(next.next_step) ||
      next.next_step < 0 || !Array.isArray(next.frames) ||
      next.frames.length > 64 || !next.slots || typeof next.slots !== 'object' ||
      (protocolVersion === 1 && next.frames.length === 0 && next.next_step === 0) ||
      (protocolVersion === 2 && next.frames.length !== 0) ||
      !next.frames.every(f => f && typeof f === 'object' &&
        typeof f.node_id === 'string' && /^[A-Za-z0-9_.-]{1,120}$/.test(f.node_id) &&
        Number.isSafeInteger(f.iteration) && f.iteration >= 0)) {
    throw new Error('invalid native effect suspension');
  }
  await store.prepareEffect({
    executionId, workerId, epoch: state.epoch, nodeId: effect.node_id,
    effectId: effect.effect_id, operation: effect.operation,
    args: effect.args, slots: next.slots, continuation: next,
    resultSlot: effect.result_slot, protocolVersion,
    ...(onError && { onError: { nextStep: onError.next_step, errorSlot: onError.error_slot } }),
  });
  return { status: 'waiting_effect', effectId: effect.effect_id };
}

// The signed registry is the only entry point intended for a future
// launcher. User/workflow input provides ONLY executionId, not a path.
export async function executeRegisteredNativeStep({ store, registry, executionId,
                                                     workerId, timeoutMs }) {
  if (!registry || typeof registry.resolve !== 'function') {
    throw new Error('trusted native artifact registry required');
  }
  const state = await store.get(executionId);
  if (!state) throw new Error('native execution not found');
  const artifact = await registry.resolve({
    sha256: state.artifactSha256,
    protocolVersion: state.protocolVersion || 1,
  });
  return executeNativeStep({
    store, executionId, workerId, executable: artifact.executable,
    sha256: artifact.sha256, timeoutMs,
    allowedOperations: artifact.allowedOperations,
  });
}
