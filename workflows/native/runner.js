// Opt-in native artifact runner. Executable paths must come from a trusted,
// SHA-256-verified artifact registry, never from workflow input.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const MAX_INPUT = 1024 * 1024;
const MAX_OUTPUT = 4 * 1024 * 1024;

export async function runNativeArtifact({ executable, sha256, input, timeoutMs = 30_000 }) {
  if (typeof executable !== 'string' || !executable.startsWith('/') ||
      !/^[a-f0-9]{64}$/.test(sha256 || '')) throw new Error('trusted absolute executable and SHA-256 required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error('invalid timeout');
  const bytes = await readFile(executable);
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('artifact SHA-256 mismatch');
  const payload = JSON.stringify(input);
  if (Buffer.byteLength(payload) > MAX_INPUT) throw new Error('native input too large');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let stdout = '', stderr = '', outputBytes = 0, settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('native execution timeout')); }, timeoutMs);
    child.on('error', error => finish(error));
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT) {
        child.kill('SIGKILL'); finish(new Error('native output too large'));
      } else stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk.toString('utf8').slice(0, 4096 - stderr.length); });
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) return finish(new Error(`native process exited ${code}: ${stderr}`));
      try { finish(null, JSON.parse(stdout)); } catch { finish(new Error('invalid native JSON result')); }
    });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') finish(error); });
    child.stdin.end(payload);
  });
}

export async function executePureNative({ store, executionId, workerId, executable, sha256, timeoutMs }) {
  const leaseMs = Math.max(60_000, (timeoutMs ?? 30_000) + 10_000);
  const state = await store.claim({ executionId, workerId, leaseMs });
  if (state.completed || state.cancelled) return state;
  if (state.artifactSha256 !== sha256) throw new Error('pinned artifact mismatch');
  if (state.pendingEffect || state.checkpoint) throw new Error('continuation protocol not implemented for this artifact');
  const result = await runNativeArtifact({ executable, sha256, input: state.input, timeoutMs });
  await store.complete({ executionId, workerId, epoch: state.epoch, result });
  return { completed: true, result };
}
