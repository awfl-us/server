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

function hasExplicitNetworkArg(args = []) {
  // Detect presence of --network/--net flags in provided args
  return args.some((a, i) => {
    if (a === '--network' || a === '--net') return true;
    if (a.startsWith('--network=') || a.startsWith('--net=')) return true;
    // handle short form "-net" (rare nowadays)
    if (a === '-net') return true;
    // also handle the case of flag followed by value
    if ((a === '--network' || a === '--net' || a === '-net') && typeof args[i + 1] === 'string') return true;
    return false;
  });
}

async function detectComposeNetwork() {
  // Strategy:
  // 1) If PRODUCER_DOCKER_NETWORK is set, use it (explicit override).
  // 2) If running inside a container with access to Docker, inspect this container's networks and prefer one ending with "_default".
  // 3) Otherwise, return null (no-op; caller should avoid changing behavior).
  const override = (process.env.PRODUCER_DOCKER_NETWORK || '').trim();
  if (override) return { network: override, source: 'env:PRODUCER_DOCKER_NETWORK' };

  const containerId = (process.env.HOSTNAME || '').trim();
  if (!containerId) return { network: null, source: 'none' };

  try {
    const { stdout } = await execFileAsync('docker', ['inspect', containerId, '--format', '{{json .NetworkSettings.Networks}}'], { timeout: 5_000 });
    const networksObj = JSON.parse(stdout || '{}') || {};
    const names = Object.keys(networksObj);
    if (!names.length) return { network: null, source: 'inspect:none' };

    // Prefer names that end with _default (compose default network)
    const preferred = names.find(n => /_default$/.test(n))
      || names.find(n => n === 'server_default')
      || names[0];
    return { network: preferred || null, source: 'auto' };
  } catch {
    return { network: null, source: 'inspect:error' };
  }
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

  // Collect optional args from env and request
  const envArgStr = (process.env.PRODUCER_LOCAL_DOCKER_ARGS || '').trim();
  const envArgs = envArgStr ? splitArgs(envArgStr) : [];
  const reqArgs = Array.isArray(extraArgs) ? extraArgs : [];

  // Determine network arg only if not explicitly provided
  const explicitHasNetwork = hasExplicitNetworkArg([...envArgs, ...reqArgs]);
  let networkApplied = null;
  let networkSource = null;
  if (!explicitHasNetwork) {
    const { network, source } = await detectComposeNetwork();
    if (network) {
      args.push('--network', network);
      networkApplied = network;
      networkSource = source;
    }
  }

  // Append env/request-provided args and image
  if (envArgs.length) args.push(...envArgs);
  if (reqArgs.length) args.push(...reqArgs);
  args.push(image);

  // Diagnostics: log the docker run we are about to execute (sanitized)
  try {
    // eslint-disable-next-line no-console
    console.log('[jobs/producer][docker] docker run', {
      image,
      containerName,
      extraArgs: reqArgs,
      envArgs: envArgs,
      network: networkApplied ? { value: networkApplied, source: networkSource } : (explicitHasNetwork ? { value: 'explicit', source: 'args' } : { value: null, source: 'none' }),
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
