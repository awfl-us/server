import crypto from 'crypto';
import { requiredEnv, rewriteLocalhostForDocker } from './utils.js';

export function sanitizeId(input, max = 200) {
  const s = String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9\-._~+%]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, max);
}

export function buildBaseContext({ body, localDocker }) {
  const baseWorkflowsUrl = requiredEnv('WORKFLOWS_BASE_URL');
  const workflowsBaseUrl = localDocker ? rewriteLocalhostForDocker(baseWorkflowsUrl) : baseWorkflowsUrl;
  const workflowsAudience = process.env.WORKFLOWS_AUDIENCE || baseWorkflowsUrl;
  const serviceAuthToken = process.env.SERVICE_AUTH_TOKEN || '';

  const eventsHeartbeatMs = Number.isFinite(Number(body.eventsHeartbeatMs))
    ? String(Number(body.eventsHeartbeatMs))
    : (process.env.EVENTS_HEARTBEAT_MS || '');
  const reconnectBackoffMs = Number.isFinite(Number(body.reconnectBackoffMs))
    ? String(Number(body.reconnectBackoffMs))
    : (process.env.RECONNECT_BACKOFF_MS || '');

  return { workflowsBaseUrl, workflowsAudience, serviceAuthToken, eventsHeartbeatMs, reconnectBackoffMs };
}

export function deriveEncryption({ overrideKeyB64, overrideVer }) {
  const encKeyB64 = String(overrideKeyB64 || '').trim() || crypto.randomBytes(32).toString('base64');
  const encVer = String(overrideVer || '').trim() || 'a256gcm:v1';
  let encFp = '';
  try {
    const keyBuf = Buffer.from(encKeyB64, 'base64');
    encFp = crypto.createHash('sha256').update(keyBuf).digest('hex').slice(0, 8);
  } catch {}
  return { encKeyB64, encVer, encFp };
}

export function buildProducerEnv({
  userId,
  projectId,
  workspaceId,
  sessionId,
  since_id,
  since_time,
  workflowsBaseUrl,
  workflowsAudience,
  serviceAuthToken,
  leaseMs,
  encKeyB64,
  encVer,
  eventsHeartbeatMs,
  reconnectBackoffMs,
  consumerId,
}) {
  const envPairs = [
    { name: 'X_USER_ID', value: userId },
    { name: 'X_PROJECT_ID', value: projectId },
    ...(workspaceId ? [{ name: 'X_WORKSPACE_ID', value: workspaceId }] : []),
    ...(sessionId ? [{ name: 'X_SESSION_ID', value: sessionId }] : []),
    ...(since_id ? [{ name: 'SINCE_ID', value: since_id }] : []),
    ...(since_time ? [{ name: 'SINCE_TIME', value: since_time }] : []),
    { name: 'WORKFLOWS_BASE_URL', value: workflowsBaseUrl },
    { name: 'WORKFLOWS_AUDIENCE', value: workflowsAudience },
    ...(serviceAuthToken ? [{ name: 'SERVICE_AUTH_TOKEN', value: serviceAuthToken }] : []),
    ...(eventsHeartbeatMs ? [{ name: 'EVENTS_HEARTBEAT_MS', value: eventsHeartbeatMs }] : []),
    ...(reconnectBackoffMs ? [{ name: 'RECONNECT_BACKOFF_MS', value: reconnectBackoffMs }] : []),
    { name: 'CONSUMER_ID', value: consumerId },
    { name: 'GCS_BUCKET', value: process.env.GCS_BUCKET },
    { name: 'GCS_DEBUG', value: '1' },
    { name: 'LOCK_LEASE_MS', value: String(leaseMs) },
    { name: 'ENC_KEY_B64', value: encKeyB64 },
    { name: 'ENC_VER', value: encVer },
  ];
  return envPairs;
}

export function buildLocalConsumerEnv({
  workflowsBaseUrl,
  eventsHeartbeatMs,
  reconnectBackoffMs,
  encKeyB64,
  encVer,
  topic,
  subReq,
}) {
  // Pub/Sub worker env for local consumer. No HTTP sidecar.
  const env = [
    ...(workflowsBaseUrl ? [{ name: 'WORKFLOWS_BASE_URL', value: workflowsBaseUrl }] : []),
    ...(eventsHeartbeatMs ? [{ name: 'EVENTS_HEARTBEAT_MS', value: eventsHeartbeatMs }] : []),
    ...(reconnectBackoffMs ? [{ name: 'RECONNECT_BACKOFF_MS', value: reconnectBackoffMs }] : []),
    { name: 'GCS_BUCKET', value: process.env.GCS_BUCKET },
    { name: 'GCS_DEBUG', value: '1' },
    { name: 'ENC_KEY_B64', value: encKeyB64 },
    { name: 'ENC_VER', value: encVer },
    { name: 'PUBSUB_ENABLE', value: '1' },
    { name: 'TOPIC', value: topic },
    { name: 'SUBSCRIPTION', value: subReq },
    { name: 'REPLY_CHANNEL', value: 'resp' },
    { name: 'GCS_TRACE', value: '0' },
    { name: 'GCS_DEBUG', value: '0' }
  ];
  return env;
}
