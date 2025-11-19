import axios from 'axios';
import { createParser } from 'eventsource-parser';
import { GoogleAuth } from 'google-auth-library';
import { ensureWorkRoot } from './storage.js';
import { PassThrough } from 'stream';
import http from 'http';
import https from 'https';
import { getDownscopedToken, renderPrefixTemplate as renderGcsPrefixTemplate } from './gcs-downscope.js';

// Env config
const WORKFLOWS_BASE_URL = process.env.WORKFLOWS_BASE_URL || '';
const WORKFLOWS_AUDIENCE = process.env.WORKFLOWS_AUDIENCE || WORKFLOWS_BASE_URL;
const CONSUMER_BASE_URL = process.env.CONSUMER_BASE_URL || '';
const SERVICE_AUTH_TOKEN = process.env.SERVICE_AUTH_TOKEN || '';
// Optional downscoped GCS access token to pass to consumer (temporary until minting is wired)
const GCS_TOKEN_ENV = process.env.GCS_TOKEN || process.env.X_GCS_TOKEN || '';
const GCS_BUCKET = process.env.GCS_BUCKET || '';
const GCS_PREFIX_TEMPLATE = process.env.GCS_PREFIX_TEMPLATE || '{userId}/{projectId}/{workspaceId}/{sessionId}/';
const GCS_DEBUG = /^1|true|yes$/i.test(String(process.env.GCS_DEBUG || ''));

// Context
const X_USER_ID = process.env.X_USER_ID || process.env.USER_ID || '';
const X_PROJECT_ID = process.env.X_PROJECT_ID || process.env.PROJECT_ID || '';
const X_WORKSPACE_ID = process.env.X_WORKSPACE_ID || process.env.WORKSPACE_ID || '';
const X_SESSION_ID = process.env.X_SESSION_ID || process.env.SESSION_ID || '';
const SINCE_ID = process.env.SINCE_ID || '';
const SINCE_TIME = process.env.SINCE_TIME || '';
const CONSUMER_ID = process.env.CONSUMER_ID || '';

const EVENTS_HEARTBEAT_MS = Number(process.env.EVENTS_HEARTBEAT_MS || 15000);
const RECONNECT_BACKOFF_MS = Number(process.env.RECONNECT_BACKOFF_MS || 1000);

if (!WORKFLOWS_BASE_URL) {
  console.error('[producer] WORKFLOWS_BASE_URL is required');
  process.exit(2);
}
if (!CONSUMER_BASE_URL) {
  console.error('[producer] CONSUMER_BASE_URL is required');
  process.exit(2);
}
if (!X_USER_ID || !X_PROJECT_ID) {
  console.error('[producer] X_USER_ID and X_PROJECT_ID are required');
  process.exit(2);
}

const auth = new GoogleAuth();
async function getWorkflowsIdTokenHeaders(aud) {
  const audience = aud || WORKFLOWS_AUDIENCE || WORKFLOWS_BASE_URL;
  try {
    const client = await auth.getIdTokenClient(audience);
    const headers = await client.getRequestHeaders(audience);
    return headers; // Authorization Bearer token
  } catch {
    return {};
  }
}

function consumerHeaders({ gcsToken } = {}) {
  const h = {
    'Content-Type': 'application/x-ndjson',
    'X-User-Id': X_USER_ID,
    'X-Project-Id': X_PROJECT_ID,
    // Do not set Content-Length to enable chunked streaming
    // 'Transfer-Encoding' will be set automatically by Node for streams
  };
  if (X_WORKSPACE_ID) h['X-Workspace-Id'] = X_WORKSPACE_ID;
  if (X_SESSION_ID) h['X-Session-Id'] = X_SESSION_ID;
  if (SERVICE_AUTH_TOKEN) h['Authorization'] = `Bearer ${SERVICE_AUTH_TOKEN}`;
  if (gcsToken) h['X-Gcs-Token'] = gcsToken; // pass downscoped token (if provided)
  return h;
}

function contextHeaders() {
  const h = {
    'X-User-Id': X_USER_ID,
    'X-Project-Id': X_PROJECT_ID,
  };
  if (X_WORKSPACE_ID) h['X-Workspace-Id'] = X_WORKSPACE_ID;
  return h;
}

async function postCallback(callbackId, payload) {
  const url = `${WORKFLOWS_BASE_URL.replace(/\/$/, '')}/callbacks/${encodeURIComponent(callbackId)}`;
  const authz = await getWorkflowsIdTokenHeaders();
  const headers = {
    'Content-Type': 'application/json',
    ...contextHeaders(),
    ...authz,
  };

  const maxAttempts = 3;
  let attempt = 0;
  let useWrapper = false; // on 400, retry with { result: payload }
  while (attempt < maxAttempts) {
    attempt++;
    try {
      const body = useWrapper ? { result: payload } : payload;
      const resp = await axios.post(url, body, { headers, timeout: 20000, validateStatus: s => s < 500 });
      if (resp.status >= 200 && resp.status < 300) return;
      if (resp.status === 400 && !useWrapper) {
        console.warn('[producer] callback 400; retrying with wrapper { result: ... }');
        useWrapper = true;
        continue; // immediate retry without backoff count
      }
      throw new Error(`callback_http_${resp.status}`);
    } catch (err) {
      const status = err?.response?.status;
      if (status === 400 && !useWrapper) {
        console.warn('[producer] callback 400; retrying with wrapper { result: ... }');
        useWrapper = true;
        continue;
      }
      const backoff = 300 * attempt + Math.floor(Math.random() * 200);
      await new Promise((r) => setTimeout(r, backoff));
      if (attempt >= maxAttempts) throw err;
    }
  }
}

async function postCursor({ eventId, timestamp }) {
  // Always record project-wide cursor with simple retry/backoff
  const url = `${WORKFLOWS_BASE_URL.replace(/\/$/, '')}/events/cursors`;
  const authz = await getWorkflowsIdTokenHeaders();
  const headers = {
    'Content-Type': 'application/json',
    ...contextHeaders(),
    ...authz,
  };
  const body = {
    projectId: X_PROJECT_ID,
    eventId,
    timestamp,
    target: 'project',
  };
  const maxAttempts = 3;
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt++;
    try {
      await axios.post(url, body, { headers, timeout: 15000 });
      return;
    } catch (err) {
      const backoff = 250 * attempt + Math.floor(Math.random() * 150);
      await new Promise((r) => setTimeout(r, backoff));
      if (attempt >= maxAttempts) {
        console.warn('[producer] failed to update project cursor after retries', err?.message || err);
        return;
      }
    }
  }
}

async function getProjectCursor() {
  // Best-effort fetch of the persisted project-wide cursor
  const base = WORKFLOWS_BASE_URL.replace(/\/$/, '');
  const url = `${base}/events/cursors`;
  const authz = await getWorkflowsIdTokenHeaders();
  const headers = {
    Accept: 'application/json',
    ...contextHeaders(),
    ...authz,
  };
  try {
    const resp = await axios.get(url, {
      headers,
      params: { projectId: X_PROJECT_ID, target: 'project' },
      timeout: 15000,
      validateStatus: (s) => s < 500,
    });
    const data = resp?.data || {};
    const cursor = data.cursor || data;
    if (cursor && (cursor.eventId || cursor.since_id || cursor.timestamp || cursor.since_time)) {
      return {
        eventId: cursor.eventId || cursor.since_id || undefined,
        timestamp: cursor.timestamp || cursor.since_time || undefined,
      };
    }
  } catch (err) {
    console.warn('[producer] could not fetch project cursor; starting from env/defaults', err?.message || err);
  }
  return null;
}

function parseToolArgs(maybe) {
  if (maybe == null) return {};
  if (typeof maybe === 'string') {
    try { const p = JSON.parse(maybe); return typeof p === 'object' ? p : { raw: maybe }; } catch { return { raw: maybe }; }
  }
  if (typeof maybe === 'object') return maybe;
  return { value: maybe };
}

// Persistent consumer connection (duplex NDJSON)
function createPersistentConsumerClient(headers) {
  const url = `${CONSUMER_BASE_URL.replace(/\/$/, '')}/sessions/stream`;

  // Keep-alive agents
  const isHttps = /^https:/i.test(url);
  const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 1 });
  const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 1 });

  let reqStream = null; // PassThrough for request body
  let respStream = null; // Incoming response stream
  let connected = false;
  let connecting = null;

  // One-in-flight semantics
  let inflight = null; // { resolve, reject, timeoutId }
  const queue = []; // [{ line, resolve, reject, timeoutId }]

  function logHeadersSafe(h) {
    const out = { ...h };
    if (out.Authorization) out.Authorization = '[redacted]';
    if (out['X-Gcs-Token']) out['X-Gcs-Token'] = '[redacted]';
    return out;
  }

  async function connect() {
    if (connected) return;
    if (connecting) return connecting;

    connecting = new Promise(async (resolve, reject) => {
      try {
        // Create the PassThrough and write an initial keepalive newline immediately so
        // proxies/load-balancers don't 408 the request for lack of body data.
        reqStream = new PassThrough();
        try { reqStream.write('\n'); } catch {}

        const safeHeaders = logHeadersSafe(headers);
        console.log('[producer] -> consumer OPEN', { url, headers: safeHeaders });
        const resp = await axios.post(url, reqStream, {
          headers,
          responseType: 'stream',
          timeout: 0,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          validateStatus: () => true,
          httpAgent,
          httpsAgent,
        });

        const sock = resp?.request?.socket;
        if (sock) {
          console.log('[producer] consumer connected', {
            status: resp.status,
            local: { address: sock.localAddress, port: sock.localPort, family: sock.localFamily },
            remote: { address: sock.remoteAddress, port: sock.remotePort },
          });
        } else {
          console.log('[producer] consumer response', { status: resp.status });
        }

        respStream = resp.data;
        respStream.setEncoding('utf8');
        let buf = '';
        respStream.on('data', (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            // Ignore non-JSON pings/ready
            if (line.startsWith('ready') || line.startsWith('ping') || line.startsWith('error ')) {
              continue;
            }
            let obj = null;
            try { obj = JSON.parse(line); } catch { obj = null; }
            if (!obj) continue;
            if (Object.prototype.hasOwnProperty.call(obj, 'result') || Object.prototype.hasOwnProperty.call(obj, 'error')) {
              // Resolve current inflight
              const current = inflight;
              inflight = null;
              if (current) {
                clearTimeout(current.timeoutId);
                if (Object.prototype.hasOwnProperty.call(obj, 'error') && obj.error) current.reject(new Error(obj.error?.message || 'consumer_error'));
                else current.resolve(obj);
              }
              // Immediately try to send next from queue
              drainQueue();
            }
          }
        });
        respStream.on('end', () => {
          console.log('[producer] consumer stream ended');
          teardownAndRejectPending(new Error('consumer_stream_end'));
          scheduleReconnect('end');
        });
        respStream.on('error', (e) => {
          console.warn('[producer] consumer stream error', e?.message || e);
          teardownAndRejectPending(e);
          scheduleReconnect('error');
        });

        connected = true;
        resolve();
        // After connected, try to drain any queued items
        drainQueue();
      } catch (err) {
        console.warn('[producer] consumer connect failed', err?.message || err);
        teardownAndRejectPending(err);
        scheduleReconnect('connect_error');
        reject(err);
      } finally {
        connecting = null;
      }
    });

    return connecting;
  }

  function teardownAndRejectPending(err) {
    connected = false;
    try { reqStream?.end(); } catch {}
    reqStream = null;
    try { respStream?.destroy(); } catch {}
    respStream = null;

    // Reject inflight and queued
    if (inflight) {
      clearTimeout(inflight.timeoutId);
      inflight.reject(err);
      inflight = null;
    }
    while (queue.length) {
      const item = queue.shift();
      clearTimeout(item.timeoutId);
      item.reject(err);
    }
  }

  let reconnectDelay = RECONNECT_BACKOFF_MS;
  const reconnectCap = 30000;
  function scheduleReconnect(reason) {
    const jitter = Math.floor(Math.random() * 250);
    const delay = Math.min(reconnectDelay + jitter, reconnectCap);
    console.log('[producer] reconnecting consumer in', delay, 'ms due to', reason);
    setTimeout(() => { connect().catch(() => {}); }, delay);
    reconnectDelay = Math.min(reconnectDelay * 2, reconnectCap);
  }

  function ensureConnected() {
    if (connected) return Promise.resolve();
    return connect();
  }

  function drainQueue() {
    if (!connected || inflight) return;
    const next = queue.shift();
    if (!next) return;
    inflight = next;
    try {
      reqStream.write(next.line + '\n');
    } catch (err) {
      clearTimeout(next.timeoutId);
      inflight = null;
      next.reject(err);
      scheduleReconnect('write_error');
    }
  }

  function send(obj, { timeoutMs = 20000 } = {}) {
    const line = JSON.stringify(obj);
    return new Promise(async (resolve, reject) => {
      const timeoutId = setTimeout(() => {
        // If this item is in-flight, clear and force reconnect to unblock
        if (inflight && inflight.timeoutId === timeoutId) {
          inflight = null;
          scheduleReconnect('per-send-timeout');
        }
        reject(new Error('consumer_send_timeout'));
      }, timeoutMs);

      const item = { line, resolve, reject, timeoutId };
      queue.push(item);

      try {
        await ensureConnected();
        drainQueue();
      } catch (err) {
        clearTimeout(timeoutId);
        reject(err);
      }
    });
  }

  return { send };
}

async function run() {
  console.log('[producer] starting with context', { X_USER_ID, X_PROJECT_ID, X_WORKSPACE_ID, X_SESSION_ID, SINCE_ID, SINCE_TIME, CONSUMER_ID });
  console.log('[producer] configuration', { CONSUMER_BASE_URL, EVENTS_HEARTBEAT_MS, RECONNECT_BACKOFF_MS });

  // Ensure project-scoped work root exists (for mounted storage); non-fatal if it fails
  try {
    const workRoot = await ensureWorkRoot({ userId: X_USER_ID, projectId: X_PROJECT_ID, workspaceId: X_WORKSPACE_ID, sessionId: X_SESSION_ID });
    console.log('[producer] work root ready at', workRoot);
  } catch (err) {
    console.warn('[producer] work root not available (continuing without persistence):', err?.message || err);
  }

  // Compute downscoped GCS token (mint if not provided via env)
  let gcsTokenToUse = GCS_TOKEN_ENV;
  let gcsPrefix = '';
  if (!gcsTokenToUse && GCS_BUCKET) {
    try {
      gcsPrefix = renderGcsPrefixTemplate(GCS_PREFIX_TEMPLATE, { userId: X_USER_ID, projectId: X_PROJECT_ID, workspaceId: X_WORKSPACE_ID, sessionId: X_SESSION_ID });
      const token = await getDownscopedToken({ bucket: GCS_BUCKET, prefix: gcsPrefix });
      gcsTokenToUse = token;
      console.log('[producer] minted downscoped GCS token', { bucket: GCS_BUCKET, prefix: gcsPrefix });
    } catch (err) {
      console.warn('[producer] failed to mint downscoped GCS token; continuing without header', err?.message || err);
      if (GCS_DEBUG) console.warn('[producer] gcs mint debug', { stack: err?.stack, details: err?.details });
    }
  }

  // Fetch persisted project-wide cursor (best effort)
  let initialSinceId = SINCE_ID || undefined;
  let initialSinceTime = SINCE_TIME || undefined;
  try {
    const cursor = await getProjectCursor();
    if (cursor?.eventId) initialSinceId = cursor.eventId;
    else if (cursor?.timestamp) initialSinceTime = cursor.timestamp;
    if (initialSinceId || initialSinceTime) {
      console.log('[producer] starting from persisted cursor', { initialSinceId, initialSinceTime });
    }
  } catch (_) {
    // ignore; will fall back to env/defaults
  }

  let lastEventId = undefined;
  let reconnectDelay = RECONNECT_BACKOFF_MS;
  const reconnectCap = 30000;

  // Create persistent consumer client
  const headers = consumerHeaders({ gcsToken: gcsTokenToUse });
  const consumer = createPersistentConsumerClient(headers);

  async function connectEvents() {
    const params = new URLSearchParams();
    // Always include projectId; optionally narrow by workspace
    params.set('projectId', X_PROJECT_ID);
    if (X_WORKSPACE_ID) params.set('workspaceId', X_WORKSPACE_ID);

    if (lastEventId || initialSinceId) params.set('since_id', lastEventId || initialSinceId);
    else if (initialSinceTime) params.set('since_time', initialSinceTime);

    const url = `${WORKFLOWS_BASE_URL.replace(/\/$/, '')}/events/stream?${params.toString()}`;
    const authz = await getWorkflowsIdTokenHeaders();

    console.log('[producer] connecting to', url);

    let cancelSource = axios.CancelToken.source();

    const parser = createParser((event) => {
      if (event.type === 'event' || event.type === 'message') {
        if (event.id) lastEventId = event.id;
        if (!event.data) return;
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        handleEvent(data).catch((err) => {
          console.warn('[producer] handleEvent error', err?.message || err);
        });
      }
    });

    try {
      const response = await axios.get(url, {
        headers: {
          Accept: 'text/event-stream',
          ...authz,
          ...contextHeaders(),
        },
        responseType: 'stream',
        timeout: 0,
        cancelToken: cancelSource.token,
      });

      response.data.on('data', (chunk) => parser.feed(chunk.toString()));
      response.data.on('end', () => scheduleReconnect('end'));
      response.data.on('error', (e) => scheduleReconnect(e?.message || 'error'));
    } catch (err) {
      scheduleReconnect(err?.message || 'connect_error');
    }

    function scheduleReconnect(reason) {
      const jitter = Math.floor(Math.random() * 250);
      const delay = Math.min(reconnectDelay + jitter, reconnectCap);
      console.log('[producer] reconnect in', delay, 'ms due to', reason);
      setTimeout(connectEvents, delay);
      reconnectDelay = Math.min(reconnectDelay * 2, reconnectCap);
    }
  }

  async function handleEvent(evt) {
    const tool = evt?.tool_call?.function?.name;
    if (!tool) return; // ignore
    const args = parseToolArgs(evt?.tool_call?.function?.arguments);

    // Prepare a minimal event to send to consumer
    const forwardEvt = { ...evt, tool_call: { function: { name: tool, arguments: args } } };

    let payload = null;
    try {
      payload = await consumer.send(forwardEvt, { timeoutMs: Math.max(15000, EVENTS_HEARTBEAT_MS * 2) });
    } catch (_) {
      // ignore; payload stays null
    }

    // Derive tool result only; ignore metadata and errors per policy
    let toolResult = null;
    if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'result')) {
      toolResult = payload.result;
    } else if (payload !== undefined) {
      toolResult = payload; // in case consumer already returns raw result
    }

    // Post callback if requested, passing only the tool result (with compatibility fallback)
    if (evt?.callback_id) {
      try {
        await postCallback(evt.callback_id, toolResult);
      } catch (err) {
        console.warn('[producer] callback post failed', err?.message || err);
      }
    }

    // Update project-wide cursor
    const cursorTs = evt.create_time || evt.time || Date.now();
    await postCursor({ eventId: evt.id || lastEventId || '', timestamp: cursorTs });
  }

  await connectEvents();
}

run().catch((err) => {
  console.error('[producer] fatal', err);
  process.exit(1);
});
