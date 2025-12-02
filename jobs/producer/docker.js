import { splitArgs } from './utils.js';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);

export function toDockerEnvFlags(envPairs) {
  const flags = [];
  for (const { name, value } of envPairs) {
    if (typeof value === 'undefined' || value === null) continue;
    flags.push('-e', `${name}=${String(value)}`);
  }
  return flags;
}

function sanitizeEnvPairs(envPairs = []) {
  const redactionRe = /token|secret|authorization|auth|password|key/i;
  return envPairs.map(({ name, value }) => {
    const v = String(value ?? '');
    return { name, value: redactionRe.test(name) ? '[redacted]' : (v.length > 200 ? v.slice(0, 200) + '\u2026' : v) };
  });
}

async function tryResolveHostPathForMountedFile(inContainerPath) {
  // Best-effort: inspect this container's mounts and find the host Source for the given Destination.
  // Works only when running with access to the host Docker daemon via /var/run/docker.sock.
  if (!inContainerPath) return null;
  const containerId = process.env.HOSTNAME;
  if (!containerId) return null;
  try {
    const { stdout } = await execFileAsync('docker', ['inspect', containerId, '--format', '{{json .Mounts}}'], { timeout: 5_000 });
    const mounts = JSON.parse(stdout || '[]');
    const match = mounts.find(m => m.Destination === inContainerPath);
    if (match && match.Source) return match.Source;
  } catch {
    // ignore; fallback to env-based path if provided
  }
  return null;
}

export async function runLocalDocker({ image, containerName, envPairs, extraArgs = [] }) {
  const args = ['run', '-d', '--rm', '--name', containerName, ...toDockerEnvFlags(envPairs)];

  // If provided, mount a host service account key into the producer container and set ADC path.
  // This is needed for minting downscoped GCS tokens when not running on GCP metadata.
  // Provide a host path via PRODUCER_CREDENTIALS_HOST_PATH (or GOOGLE_CREDENTIALS_HOST_PATH), e.g.:
  //   PRODUCER_CREDENTIALS_HOST_PATH=/abs/path/to/serviceAccountKey.json
  // Optionally override the in-container mount path with PRODUCER_CREDENTIALS_MOUNT_PATH
  let keyHostPath = (process.env.PRODUCER_CREDENTIALS_HOST_PATH || process.env.GOOGLE_CREDENTIALS_HOST_PATH || '').trim();
  const mountTarget = (process.env.PRODUCER_CREDENTIALS_MOUNT_PATH || '/var/run/secrets/google/key.json').trim();

  // If no explicit host path provided, try to auto-detect the host source of the ADC file
  // already mounted into this js-server container (e.g., /app/serviceAccountKey.json).
  if (!keyHostPath) {
    const adcPathInServer = (process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
    const resolved = await tryResolveHostPathForMountedFile(adcPathInServer);
    if (resolved) keyHostPath = resolved;
  }

  if (keyHostPath) {
    args.push('-v', `${keyHostPath}:${mountTarget}:ro`);
    args.push('-e', `GOOGLE_APPLICATION_CREDENTIALS=${mountTarget}`);
  }

  // optional mounts/args (global default for producer container only)
  const argStr = (process.env.PRODUCER_LOCAL_DOCKER_ARGS || '').trim();
  if (argStr) args.push(...splitArgs(argStr));
  if (Array.isArray(extraArgs) && extraArgs.length) args.push(...extraArgs);
  args.push(image);

  // Diagnostics: log the docker run we are about to execute (sanitized)
  try {
    // eslint-disable-next-line no-console
    console.log('[jobs/producer][docker] docker run', {
      image,
      containerName,
      extraArgs,
      // Note: GOOGLE_APPLICATION_CREDENTIALS value will be printed, which is a file path only.
      env: sanitizeEnvPairs(envPairs),
      adc: keyHostPath ? { mounted: true, mountPath: mountTarget } : { mounted: false },
    });
  } catch {}

  const { stdout } = await execFileAsync('docker', args, { timeout: 60_000 });
  const id = stdout.trim();

  // Diagnostics: container id
  try { console.log('[jobs/producer][docker] started container', { containerName, id }); } catch {}

  return { id, args };
}

export async function stopContainer(nameOrId) {
  try {
    await execFileAsync('docker', ['stop', '-t', '5', nameOrId], { timeout: 30_000 });
    try { console.log('[jobs/producer][docker] stopped container', { nameOrId }); } catch {}
  } catch {
    // best-effort; ignore
  }
}

export async function waitContainer(nameOrId) {
  // Blocks until the specified container stops; returns exit status.
  try {
    const { stdout } = await execFileAsync('docker', ['wait', nameOrId], { timeout: 0, maxBuffer: 10 * 1024 });
    const code = parseInt(String(stdout || '').trim(), 10);
    return { exited: true, exitCode: Number.isNaN(code) ? null : code };
  } catch (e) {
    // If the container doesn't exist or docker isn't reachable, surface a structured result.
    return { exited: false, error: e?.message || String(e) };
  }
}
