// Centralized configuration for SSE consumer app

export const NODE_ENV = process.env.NODE_ENV || 'development';

// Upstream workflows/events service base URL
export const WORKFLOWS_BASE_URL = process.env.WORKFLOWS_BASE_URL || 'http://localhost:8081';
// Optional audience to request identity tokens for (OIDC)
export const WORKFLOWS_AUDIENCE = process.env.WORKFLOWS_AUDIENCE || '';

// Inbound service-to-service auth token (shared secret). If unset, auth is skipped.
export const SERVICE_AUTH_TOKEN = process.env.SERVICE_AUTH_TOKEN || '';

// Filesystem work root base directory for per-session/project workspace
export const WORK_ROOT_BASE = process.env.WORK_ROOT_BASE || '/workspace';

// Optional path prefix template for workspace layout under WORK_ROOT_BASE.
// Supports {userId},{projectId},{workspaceId},{sessionId}
// Defaults to the prior layout to preserve behavior.
export const WORK_PREFIX_TEMPLATE = process.env.WORK_PREFIX_TEMPLATE || '{userId}/{projectId}/{workspaceId}/{sessionId}';

// GCS sync configuration
// JSON API base for GCS
export const GCS_API_BASE = process.env.GCS_API_BASE || 'https://www.googleapis.com';
// Max number of parallel downloads when syncing
export const GCS_DOWNLOAD_CONCURRENCY = Number(process.env.GCS_DOWNLOAD_CONCURRENCY || 8);
// Max number of parallel uploads when syncing
export const GCS_UPLOAD_CONCURRENCY = Number(process.env.GCS_UPLOAD_CONCURRENCY || 4);
// Enable pushing modified local files back to GCS (default: enabled)
export const GCS_ENABLE_UPLOAD = ['1','true','yes'].includes(String(process.env.GCS_ENABLE_UPLOAD || '1').toLowerCase());
// Bucket to sync from (producer-provided token should be scoped to this bucket/prefix)
export const GCS_BUCKET = process.env.GCS_BUCKET || '';
// Prefix template for objects within the bucket to mirror into the work root
// Supports {userId},{projectId},{workspaceId},{sessionId}
export const GCS_PREFIX_TEMPLATE = process.env.GCS_PREFIX_TEMPLATE || '{userId}/{projectId}/{workspaceId}/{sessionId}/';
// Trigger an initial sync automatically when /sessions/stream is established
export const SYNC_ON_START = ['1','true','yes'].includes(String(process.env.SYNC_ON_START || '1').toLowerCase());
// Interval in ms to re-run GCS sync while the stream is open
export const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS || 15000);

// Stream heartbeat interval back to the producer
export const EVENTS_HEARTBEAT_MS = Number(process.env.EVENTS_HEARTBEAT_MS || 15000);

// Tooling limits
export const READ_FILE_MAX_BYTES = Number(process.env.READ_FILE_MAX_BYTES || 512 * 1024);
export const OUTPUT_MAX_BYTES = Number(process.env.OUTPUT_MAX_BYTES || 256 * 1024);
export const RUN_COMMAND_TIMEOUT_SECONDS = Number(process.env.RUN_COMMAND_TIMEOUT_SECONDS || 60);

// Server
export const PORT = Number(process.env.PORT || 8080);
