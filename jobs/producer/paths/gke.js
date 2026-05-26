import { runK8sJob, deleteK8sJob } from '../gke.js';
import { deleteSubscription } from '../pubsubAdmin.js';
import { setConsumerRuntimeInfo } from '../../../workflows/projects/lock.js';
import { scheduleStartupProgress } from '../progress.js';

// Updated GKE start path: only create the consumer Job (awfl CLI), no producer Job.
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
  topic,
  subReq,
  subResp, // retained for runtime/stop cleanup only
  sessionIdForFilter,
  githubToken,
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
  const defaultStartup = 'set -e; '
    + 'python -m pip install --user awfl && "$HOME/.local/bin/awfl" run';
  const startupSh = process.env.AWFL_STARTUP_SH || defaultStartup;

  if (!consumerImage) {
    await deleteSubscription({ gcpProject, name: subReq }).catch(() => {});
    await deleteSubscription({ gcpProject, name: subResp }).catch(() => {});
    await bestEffortRelease({ userId, projectId });
    return { status: 500, body: { error: 'Missing CONSUMER_K8S_IMAGE' } };
  }

  const consumerJobName = `consumer-${consumerId}`.slice(0, 63);

  const consumerEnv = [
    { name: 'NODE_ENV', value: 'production' },
    { name: 'PUBSUB_ENABLE', value: '1' },
    { name: 'TOPIC', value: String(topic) },
    { name: 'SUBSCRIPTION', value: String(subReq) },
    { name: 'ENC_KEY_B64', value: encKeyB64 },
    { name: 'ENC_VER', value: encVer },
    { name: 'REPLY_CHANNEL', value: 'resp' },
    { name: 'CONSUMER_ID', value: consumerId },
    { name: 'AWFL_CONSUMER_ID', value: consumerId },
    { name: 'AWFL_PROJECT_ID', value: String(projectId) },
    { name: 'AWFL_CONSUMER_TYPE', value: 'CLOUD' },
    ...(githubToken ? [{ name: 'GITHUB_TOKEN', value: githubToken }] : []),
    ...(baseCtx.workflowsBaseUrl ? [{ name: 'WORKFLOWS_BASE_URL', value: baseCtx.workflowsBaseUrl }] : []),
    ...(baseCtx.eventsHeartbeatMs ? [{ name: 'EVENTS_HEARTBEAT_MS', value: baseCtx.eventsHeartbeatMs }] : []),
    ...(baseCtx.reconnectBackoffMs ? [{ name: 'RECONNECT_BACKOFF_MS', value: baseCtx.reconnectBackoffMs }] : []),
    ...(process.env.API_ORIGIN ? [{ name: 'API_ORIGIN', value: String(process.env.API_ORIGIN) }] : []),
    { name: 'GCS_TRACE', value: '1' },
    { name: 'GCS_DEBUG', value: '1' },
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

  // Always allow these passthroughs
  const passthroughAuthEnv = {
    SKIP_AUTH: process.env.SKIP_AUTH,
    AWFL_TOKENS_JSON_B64: process.env.AWFL_TOKENS_JSON_B64,
    AWFL_TOKENS_JSON: process.env.AWFL_TOKENS_JSON,
  };
  for (const [name, value] of Object.entries(passthroughAuthEnv)) {
    if (typeof value !== 'undefined' && value !== null && String(value).length) {
      consumerEnv.push({ name, value: String(value) });
    }
  }

  let cRun;
  try {
    cRun = await runK8sJob({ namespace, jobName: consumerJobName, image: consumerImage, serviceAccountName: consumerKsa, envPairs: consumerEnv, containerName: 'consumer', shCommand: startupSh });
  } catch (e) {
    await deleteSubscription({ gcpProject, name: subReq }).catch(() => {});
    await deleteSubscription({ gcpProject, name: subResp }).catch(() => {});
    await bestEffortRelease({ userId, projectId });
    return { status: 500, body: { error: 'Transport error creating consumer K8s Job', details: String(e?.message || e) } };
  }

  if (!cRun?.ok) {
    await deleteSubscription({ gcpProject, name: subReq }).catch(() => {});
    await deleteSubscription({ gcpProject, name: subResp }).catch(() => {});
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
        sub_req: subReq,
        sub_resp: subResp,
        topic,
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
      sub_req: subReq,
      sub_resp: subResp,
      topic,
      consumerImage,
    },
  };
}
