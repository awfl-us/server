// Centralized env/config and header helpers for the producer

// Env config
export const WORKFLOWS_BASE_URL = process.env.WORKFLOWS_BASE_URL || '';
export const WORKFLOWS_AUDIENCE = process.env.WORKFLOWS_AUDIENCE || WORKFLOWS_BASE_URL;
export const CONSUMER_BASE_URL = process.env.CONSUMER_BASE_URL || '';
export const CONSUMER_AUDIENCE = process.env.CONSUMER_AUDIENCE || CONSUMER_BASE_URL;
export const SERVICE_AUTH_TOKEN = process.env.SERVICE_AUTH_TOKEN || '';
// Optional downscoped GCS access token to pass to consumer (temporary until minting is wired)
export const GCS_TOKEN_ENV = process.env.GCS_TOKEN || process.env.X_GCS_TOKEN || '';
export const GCS_BUCKET = process.env.GCS_BUCKET || '';
export const GCS_PREFIX_TEMPLATE = process.env.GCS_PREFIX_TEMPLATE || '{userId}/{projectId}/{sessionId}/';
export const GCS_DEBUG = /^1|true|yes$/i.test(String(process.env.GCS_DEBUG || ''));
export const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS || 4000);

// Lock/idle tuning
export const LOCK_LEASE_MS = Number(process.env.LOCK_LEASE_MS || process.env.X_LOCK_LEASE_MS || 10 * 60 * 1000);
export const IDLE_SHUTDOWN_MS = Number(process.env.IDLE_SHUTDOWN_MS || 5 * 60 * 1000);

// Context
export const X_USER_ID = process.env.X_USER_ID || process.env.USER_ID || '';
export const X_PROJECT_ID = process.env.X_PROJECT_ID || process.env.PROJECT_ID || '';
export const X_WORKSPACE_ID = process.env.X_WORKSPACE_ID || process.env.WORKSPACE_ID || '';
export const X_SESSION_ID = process.env.X_SESSION_ID || process.env.SESSION_ID || '';
export const SINCE_ID = process.env.SINCE_ID || '';
export const SINCE_TIME = process.env.SINCE_TIME || '';
export const CONSUMER_ID = process.env.CONSUMER_ID || '';

export const EVENTS_HEARTBEAT_MS = Number(process.env.EVENTS_HEARTBEAT_MS || 15000);
export const RECONNECT_BACKOFF_MS = Number(process.env.RECONNECT_BACKOFF_MS || 1000);

// Header helpers
export function consumerHeaders({ gcsToken } = {}) {
  const h = {
    'Content-Type': 'application/x-ndjson',
    'X-User-Id': X_USER_ID,
    'X-Project-Id': X_PROJECT_ID,
    // Do not set Content-Length to enable chunked streaming
  };
  if (X_WORKSPACE_ID) h['X-Workspace-Id'] = X_WORKSPACE_ID;
  if (X_SESSION_ID) h['X-Session-Id'] = X_SESSION_ID;
  if (SERVICE_AUTH_TOKEN) h['Authorization'] = `Bearer ${SERVICE_AUTH_TOKEN}`;
  if (gcsToken) h['X-Gcs-Token'] = gcsToken; // pass downscoped token (if provided)
  return h;
}

export function contextHeaders() {
  const h = {
    'X-User-Id': X_USER_ID,
    'X-Project-Id': X_PROJECT_ID,
  };
  if (X_WORKSPACE_ID) h['X-Workspace-Id'] = X_WORKSPACE_ID;
  return h;
}
