import { runK8sJob } from '../gke.js';
import { setConsumerRuntimeInfo } from '../../../workflows/projects/lock.js';
import { scheduleStartupProgress } from '../progress.js';

// Launch the consumer with the credentials supplied by the producer immediately.
// Refresh happens asynchronously and can fail without preventing awfl run.
// Seed the files first so gcloud and Git keep working even if refresh is unavailable.
export function consumerStartupCommand({ startupSh = 'awfl run', refreshEnabled = false } = {}) {
  if (!refreshEnabled || startupSh !== 'awfl run') return startupSh;
  return [
    'if python -c "import awfl.consumer_credentials" 2>/dev/null; then',
    '  if [ -n "${CLOUDSDK_AUTH_ACCESS_TOKEN_FILE:-}" ] && [ -n "${CLOUDSDK_AUTH_ACCESS_TOKEN:-}" ]; then',
    '    if (umask 077; printf "%s\\n" "$CLOUDSDK_AUTH_ACCESS_TOKEN" > "$CLOUDSDK_AUTH_ACCESS_TOKEN_FILE"); then',
    '      unset CLOUDSDK_AUTH_ACCESS_TOKEN',
    '    else',
    '      echo "[awfl] Google token staging failed; keeping environment credential" >&2',
    '      unset CLOUDSDK_AUTH_ACCESS_TOKEN_FILE',
    '    fi',
    '  fi',
    '  if [ -n "${AWFL_GITHUB_TOKEN_FILE:-}" ] && [ -n "${GITHUB_TOKEN:-}" ]; then',
    '    if ! (umask 077; printf "%s\\n" "$GITHUB_TOKEN" > "$AWFL_GITHUB_TOKEN_FILE"); then',
    '      echo "[awfl] GitHub token staging failed; keeping environment credential" >&2',
    '      unset AWFL_GITHUB_TOKEN_FILE',
    '    fi',
    '  fi',
    '  if [ -n "${AWFL_GITHUB_TOKEN_FILE:-}" ]; then',
    '    if ! git config --global credential.helper "!python -m awfl.consumer_credentials --git-credential"; then',
    '      echo "[awfl] Git credential helper setup failed; using startup credential" >&2',
    '    fi',
    '  fi',
    '  python -m awfl.consumer_credentials --loop &',
    'else',
    '  echo "[awfl] consumer image lacks credential refresher; using startup credentials" >&2',
    '  unset CLOUDSDK_AUTH_ACCESS_TOKEN_FILE AWFL_GITHUB_TOKEN_FILE',
    'fi',
    'exec awfl run',
  ].join('\n');
}

// Updated GKE start path: launch only the consumer Job (awfl CLI) via HTTP/SSE. No Pub/Sub.
export async function startGke({
  userId,
  projectId,
  consumerId,
  gcpProject,
  requestedConsumerImage,
  encKeyB64,
  encVer,
  encFp,
  baseCtx,
  gcsPrefix, // unused in consumer-only mode
  sessionIdForFilter,
  githubToken,
  googleCloud,
  credentialRefreshToken,
  workspaceId,
  since_id, // unused in consumer-only mode
  since_time, // unused in consumer-only mode
  leaseMs, // unused in consumer-only mode (lock now managed by consumer CLI)
  bestEffortRelease,
  // Per-request auth tokens from /start
  firebaseIdToken,
  firebaseCustomToken,
  // External lock wiring
  lockToken,
  lockId,
}) {
  const namespace = process.env.K8S_NAMESPACE || 'awfl';
  const consumerImage = requestedConsumerImage || process.env.CONSUMER_K8S_IMAGE || '';
  const consumerKsa = process.env.CONSUMER_KSA_NAME || 'consumer';

  // Default startup script for the consumer
  // Execute the AWFL CLI version baked into the existing consumer image.
  // Reinstalling from PyPI on every startup could replace the pinned version.
  const defaultStartup = 'awfl run';
  const startupSh = process.env.AWFL_STARTUP_SH || defaultStartup;
  // The former MCP path launched the same image directly (no intermediate shell).
  // Apply that small optimization to every standard project consumer as well.
  const refreshEnabled = Boolean(credentialRefreshToken && (googleCloud?.accessToken || githubToken));
  const directCommand = startupSh === defaultStartup && !refreshEnabled ? ['awfl', 'run'] : undefined;
  const effectiveStartup = consumerStartupCommand({ startupSh, refreshEnabled });

  if (!consumerImage) {
    await bestEffortRelease({ userId, projectId });
    return { status: 500, body: { error: 'Missing CONSUMER_K8S_IMAGE' } };
  }

  const consumerJobName = `consumer-${consumerId}`.slice(0, 63);

  // Resolve workflows base URL for the consumer: rewrite localhost -> API_ORIGIN (if provided)
  const rawWorkflowsBaseUrl = baseCtx?.workflowsBaseUrl || '';
  let resolvedWorkflowsBaseUrl = rawWorkflowsBaseUrl;
  let baseWasLocalhost = false;
  try {
    const u = new URL(rawWorkflowsBaseUrl);
    const host = (u.hostname || '').toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      baseWasLocalhost = true;
      if (process.env.API_ORIGIN) {
        resolvedWorkflowsBaseUrl = String(process.env.API_ORIGIN);
      }
    }
  } catch {}

  // Structured, minimal log for diagnostics (no secrets)
  try {
    console.log('[jobs/producer:gke] creating consumer job', {
      namespace,
      consumerJobName,
      image: consumerImage,
      resolvedWorkflowsBaseUrl,
      baseWasLocalhost,
      hasApiOrigin: Boolean(process.env.API_ORIGIN),
    });
    if (baseWasLocalhost && !process.env.API_ORIGIN) {
      console.warn('[jobs/producer:gke] WORKFLOWS_BASE_URL points to localhost but API_ORIGIN is not set; consumer may be unable to reach server');
    }
  } catch {}

  // HTTP/SSE consumer environment (no Pub/Sub)
  const consumerEnv = [
    { name: 'NODE_ENV', value: 'production' },
    { name: 'ENC_KEY_B64', value: encKeyB64 },
    { name: 'ENC_VER', value: encVer },
    { name: 'CONSUMER_ID', value: consumerId },
    { name: 'AWFL_CONSUMER_ID', value: consumerId },
    { name: 'AWFL_PROJECT_ID', value: String(projectId) },
    { name: 'AWFL_CONSUMER_TYPE', value: 'CLOUD' },
    ...(githubToken ? [{ name: 'GITHUB_TOKEN', value: githubToken }] : []),
    ...(refreshEnabled && githubToken ? [{ name: 'AWFL_GITHUB_TOKEN_FILE', value: '/tmp/awfl-github-token' }] : []),
    // Keep the OAuth refresh token on the server. gcloud reads the latest
    // access token from a file updated atomically by the consumer refresher.
    ...(refreshEnabled ? [
      ...(googleCloud?.accessToken ? [{ name: 'CLOUDSDK_AUTH_ACCESS_TOKEN', value: googleCloud.accessToken }] : []), // compatibility with older consumer images
      { name: 'AWFL_USER_ID', value: userId },
      { name: 'AWFL_CREDENTIAL_REFRESH_ORIGIN', value: String(process.env.API_ORIGIN || resolvedWorkflowsBaseUrl).split('/workflows')[0] },
      { name: 'AWFL_CREDENTIAL_REFRESH_CAPABILITY', value: credentialRefreshToken },
      ...(googleCloud?.accessToken ? [
        { name: 'CLOUDSDK_AUTH_ACCESS_TOKEN_FILE', value: '/tmp/awfl-google-access-token' },
        { name: 'CLOUDSDK_CORE_PROJECT', value: googleCloud.cloudProjectId },
      ] : []),
    ] : []),
    ...(resolvedWorkflowsBaseUrl ? [{ name: 'WORKFLOWS_BASE_URL', value: resolvedWorkflowsBaseUrl }] : []),
    ...(baseCtx?.eventsHeartbeatMs ? [{ name: 'EVENTS_HEARTBEAT_MS', value: baseCtx.eventsHeartbeatMs }] : []),
    ...(baseCtx?.reconnectBackoffMs ? [{ name: 'RECONNECT_BACKOFF_MS', value: baseCtx.reconnectBackoffMs }] : []),
    ...(process.env.API_ORIGIN ? [{ name: 'API_ORIGIN', value: String(process.env.API_ORIGIN) }] : []),
  ];

  // External project lock envs (awfl CLI will honor these)
  if (lockToken) {
    consumerEnv.push({ name: 'AWFL_PROJECT_LOCK_TOKEN', value: String(lockToken) });
    consumerEnv.push({ name: 'AWFL_LOCK_TOKEN', value: String(lockToken) });
  }
  if (lockId) {
    consumerEnv.push({ name: 'AWFL_PROJECT_LOCK_ID', value: String(lockId) });
    consumerEnv.push({ name: 'AWFL_LOCK_ID', value: String(lockId) });
  }
  if (leaseMs) consumerEnv.push({ name: 'AWFL_LOCK_LEASE_MS', value: String(leaseMs) });
  for (const name of ['AWFL_PROJECT_LOCK_NO_REFRESH', 'AWFL_LOCK_NO_REFRESH']) {
    if (process.env[name]) consumerEnv.push({ name, value: String(process.env[name]) });
  }

  // Auth/env overrides for the consumer-only Job
  if (firebaseIdToken) {
    consumerEnv.push({ name: 'FIREBASE_ID_TOKEN', value: String(firebaseIdToken) });
  } else if (firebaseCustomToken) {
    consumerEnv.push({ name: 'FIREBASE_CUSTOM_TOKEN', value: String(firebaseCustomToken) });
  } else {
    if (process.env.FIREBASE_ID_TOKEN) consumerEnv.push({ name: 'FIREBASE_ID_TOKEN', value: String(process.env.FIREBASE_ID_TOKEN) });
    if (process.env.FIREBASE_CUSTOM_TOKEN) consumerEnv.push({ name: 'FIREBASE_CUSTOM_TOKEN', value: String(process.env.FIREBASE_CUSTOM_TOKEN) });
  }

  // Allow selected passthroughs (auth/debug) when explicitly set on the server
  const passthroughAuthEnv = {
    SKIP_AUTH: process.env.SKIP_AUTH,
    AWFL_TOKENS_JSON_B64: process.env.AWFL_TOKENS_JSON_B64,
    AWFL_TOKENS_JSON: process.env.AWFL_TOKENS_JSON,
    GCS_TRACE: process.env.GCS_TRACE,
    GCS_DEBUG: process.env.GCS_DEBUG,
  };
  for (const [name, value] of Object.entries(passthroughAuthEnv)) {
    if (typeof value !== 'undefined' && value !== null && String(value).length) {
      consumerEnv.push({ name, value: String(value) });
    }
  }

  let cRun;
  try {
    cRun = await runK8sJob({ namespace, jobName: consumerJobName, image: consumerImage, serviceAccountName: consumerKsa, envPairs: consumerEnv, containerName: 'consumer', ...(directCommand ? { command: directCommand } : { shCommand: effectiveStartup }) });
  } catch (e) {
    await bestEffortRelease({ userId, projectId });
    return { status: 500, body: { error: 'Transport error creating consumer K8s Job', details: String(e?.message || e) } };
  }

  if (!cRun?.ok) {
    await bestEffortRelease({ userId, projectId });
    return { status: 500, body: { error: 'Failed to create consumer Kubernetes Job', consumer: cRun } };
  }

  try {
    await setConsumerRuntimeInfo({
      userId,
      projectId,
      consumerId,
      runtime: {
        mode: 'gke',
        namespace,
        producerJobName: null,
        consumerJobName,
        stopRequested: false,
        enc_ver: encVer,
        enc_fp: encFp,
        sessionId: sessionIdForFilter || null,
      },
    });
  } catch (e) {
    console.warn('[jobs/producer:gke] failed to persist runtime info', e?.message || e);
  }

  const sched = scheduleStartupProgress({ userId, projectId });
  if (!sched?.ok) console.warn('[jobs/producer:gke] progress schedule failed', sched);

  return {
    status: 202,
    body: {
      ok: true,
      mode: 'gke',
      namespace,
      producerJob: null,
      consumerJob: consumerJobName,
      consumerId,
      workspaceId,
      sessionId: sessionIdForFilter || null,
      enc_ver: encVer,
      enc_fp: encFp,
      consumerImage,
    },
  };
}
