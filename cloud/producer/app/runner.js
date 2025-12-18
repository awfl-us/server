import axios from 'axios';
import { createParser } from 'eventsource-parser';
import { ensureWorkRoot } from './storage.js';
import { getDownscopedToken, renderPrefixTemplate as renderGcsPrefixTemplate } from './gcs-downscope.js';

// Config and helpers
import {
  WORKFLOWS_BASE_URL,
  GCS_TOKEN_ENV,
  GCS_BUCKET,
  GCS_PREFIX_TEMPLATE,
  GCS_DEBUG,
  X_USER_ID,
  X_PROJECT_ID,
  X_WORKSPACE_ID,
  X_SESSION_ID,
  SINCE_ID,
  SINCE_TIME,
  CONSUMER_ID,
  EVENTS_HEARTBEAT_MS,
  RECONNECT_BACKOFF_MS,
  IDLE_SHUTDOWN_MS,
  TOPIC,
  SUBSCRIPTION,
  ENC_KEY_B64,
  contextHeaders,
} from './config.js';

import { getWorkflowsIdTokenHeaders } from './auth.js';
import { postCallback } from './callbacks.js';
import { getProjectCursor, postCursor } from './cursors.js';
import { createPubSubTransport } from './pubsub.js';
import { gracefulShutdown, registerShutdownHook } from './shutdown.js';
import { startProjectLockClient } from './lock.js';

if (!WORKFLOWS_BASE_URL) {
  console.error('[producer] WORKFLOWS_BASE_URL is required');
  process.exit(2);
}
if (!X_USER_ID || !X_PROJECT_ID) {
  console.error('[producer] X_USER_ID and X_PROJECT_ID are required');
  process.exit(2);
}
// Pub/Sub is now the only supported transport for the consumer path
if (!TOPIC) { console.error('[producer] TOPIC is required (Pub/Sub)'); process.exit(2); }
if (!SUBSCRIPTION) { console.error('[producer] SUBSCRIPTION is required (Pub/Sub)'); process.exit(2); }
if (!ENC_KEY_B64) { console.error('[producer] ENC_KEY_B64 is required (Pub/Sub)'); process.exit(2); }

function parseToolArgs(maybe) {
  if (maybe == null) return {};
  if (typeof maybe === 'string') {
    try { const p = JSON.parse(maybe); return typeof p === 'object' ? p : { raw: maybe }; } catch { return { raw: maybe }; }
  }
  if (typeof maybe === 'object') return maybe;
  return { value: maybe };
}

// Simple retry helper with exponential backoff and optional retry predicate
async function withRetries(fn, { attempts = 3, baseDelayMs = 250, label = 'retry-op', shouldRetry } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      // Allow caller or error to declare non-retryable
      const nonRetry = (typeof shouldRetry === 'function' && shouldRetry(err) === false) || err?.noRetry === true || err?.status === 404;
      if (nonRetry) {
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, i);
      if (i < attempts - 1) {
        const jitter = Math.floor(Math.random() * 100);
        const wait = delay + jitter;
        console.warn(`[producer] ${label} attempt ${i + 1} failed; retry in ${wait}ms`, err?.message || err);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

async function run() {
  console.log('[producer] starting with context', { X_USER_ID, X_PROJECT_ID, X_WORKSPACE_ID, X_SESSION_ID, SINCE_ID, SINCE_TIME, CONSUMER_ID });
  console.log('[producer] mode', { transport: 'pubsub', TOPIC, SUBSCRIPTION });

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

  // Separate received vs committed cursors
  let lastReceivedEventId = undefined; // latest seen from SSE
  let committedEventId = initialSinceId || undefined; // last successfully handled+persisted

  let reconnectDelay = RECONNECT_BACKOFF_MS;
  const reconnectCap = 30000;

  // Create Pub/Sub transport client (mandatory)
  const consumer = createPubSubTransport();
  registerShutdownHook(() => consumer.close?.());

  // Start consumer lock client (acquire + refresh loop)
  const lockClient = startProjectLockClient({ onConflict: () => gracefulShutdown(0, 'lock_conflict') });
  registerShutdownHook(() => lockClient.stop());

  // Idle shutdown timer
  let idleTimer = null;
  function resetIdleTimer(reason = 'event') {
    try { if (idleTimer) clearTimeout(idleTimer); } catch {}
    if (!Number.isFinite(IDLE_SHUTDOWN_MS) || IDLE_SHUTDOWN_MS <= 0) return;
    idleTimer = setTimeout(() => {
      console.log('[producer] idle timeout reached, shutting down', { idleMs: IDLE_SHUTDOWN_MS });
      gracefulShutdown(0, 'idle_timeout');
    }, IDLE_SHUTDOWN_MS);
    console.log('[producer] idle timer reset', { reason, idleMs: IDLE_SHUTDOWN_MS });
  }
  registerShutdownHook(() => { try { if (idleTimer) clearTimeout(idleTimer); } catch {}; idleTimer = null; });
  resetIdleTimer('start');

  // Backpressure controls for upstream SSE stream
  let currentStream = null;
  let queueDepth = 0;
  const MAX_QUEUE_DEPTH = Number(process.env.EVENT_QUEUE_MAX || 16);
  function maybePauseStream() {
    try {
      if (currentStream && queueDepth >= MAX_QUEUE_DEPTH) {
        currentStream.pause?.();
        console.log('[producer] paused upstream SSE for backpressure', { queueDepth });
      }
    } catch {}
  }
  function maybeResumeStream() {
    try {
      if (currentStream && queueDepth < Math.max(1, Math.floor(MAX_QUEUE_DEPTH / 2))) {
        currentStream.resume?.();
        console.log('[producer] resumed upstream SSE', { queueDepth });
      }
    } catch {}
  }

  // Simple in-order processing queue (concurrency = 1) to keep cursor commits ordered
  let processing = Promise.resolve();
  function enqueueEvent(data) {
    queueDepth++;
    maybePauseStream();
    processing = processing
      .then(() => handleEvent(data))
      .catch((err) => console.warn('[producer] handleEvent error', err?.message || err))
      .finally(() => { queueDepth--; maybeResumeStream(); });
  }

  // Event stream connection to Workflows
  let eventsAbortController = null;
  async function connectEvents() {
    const params = new URLSearchParams();
    // Project must be provided via header (x-project-id). Optionally narrow by workspace via query.
    if (X_WORKSPACE_ID) params.set('workspaceId', X_WORKSPACE_ID);

    // Always resume from committed cursor; fall back to initialSinceId/time only
    if (committedEventId || initialSinceId) params.set('since_id', committedEventId || initialSinceId);
    else if (initialSinceTime) params.set('since_time', initialSinceTime);

    const url = `${WORKFLOWS_BASE_URL.replace(/\/$/, '')}/events/stream?${params.toString()}`;
    const authz = await getWorkflowsIdTokenHeaders();

    // Build headers and ensure x-project-id is set (lowercase) for the stream
    const hdrs = {
      Accept: 'text/event-stream',
      ...authz,
      ...contextHeaders(),
    };
    // Normalize to lowercase header key explicitly as some servers look for exact casing
    if (hdrs['X-Project-Id'] && !hdrs['x-project-id']) {
      hdrs['x-project-id'] = hdrs['X-Project-Id'];
      delete hdrs['X-Project-Id'];
    }

    console.log('[producer] connecting to', url);
    // Emit a brief, non-sensitive header log for verification
    console.log('[producer] stream header check', {
      'x-project-id': hdrs['x-project-id'] || '(missing)',
      'x-workspace-id': hdrs['x-workspace-id'] || hdrs['X-Workspace-Id'] || '(none)',
    });

    const parser = createParser((event) => {
      if (event.type === 'event' || event.type === 'message') {
        if (event.id) lastReceivedEventId = event.id; // do NOT advance committed cursor here
        if (!event.data) return;
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        // Ensure the inner JSON carries the SSE event id for downstream processing/logging
        if (event.id && !data.id) data.id = event.id;
        // Minimal visibility into events being forwarded
        const toolName = data?.tool_call?.function?.name;
        const evMeta = { id: data?.id || event.id, tool: toolName, create_time: data?.create_time || data?.time, workspaceId: X_WORKSPACE_ID };
        console.log('[producer] event received', evMeta);
        resetIdleTimer('event');
        enqueueEvent(data);
      }
    });

    eventsAbortController = new AbortController();
    try {
      const response = await axios.get(url, {
        headers: hdrs,
        responseType: 'stream',
        timeout: 0,
        signal: eventsAbortController.signal,
      });

      currentStream = response.data;
      response.data.on('data', (chunk) => parser.feed(chunk.toString()));
      response.data.on('end', () => { currentStream = null; scheduleReconnect('end'); });
      response.data.on('error', (e) => { currentStream = null; scheduleReconnect(e?.message || 'error'); });
    } catch (err) {
      scheduleReconnect(err?.message || 'connect_error');
    }

    function scheduleReconnect(reason) {
      const jitter = Math.floor(Math.random() * 250);
      const delay = Math.min(reconnectDelay + jitter, reconnectCap);
      console.log('[producer] reconnect in', delay, 'ms due to', reason, { committedEventId, lastReceivedEventId });
      setTimeout(connectEvents, delay);
      reconnectDelay = Math.min(reconnectDelay * 2, reconnectCap);
    }
  }
  registerShutdownHook(() => { try { eventsAbortController?.abort(); } catch {}; eventsAbortController = null; });

  // Send the downscoped GCS token only once at start (first message)
  let gcsBootstrapSent = false;

  async function handleEvent(evt) {
    const tool = evt?.tool_call?.function?.name;
    if (!tool) return false; // ignore
    const args = parseToolArgs(evt?.tool_call?.function?.arguments);

    // Prepare a minimal event to send to consumer
    const forwardEvt = { ...evt, tool_call: { function: { name: tool, arguments: args } } };

    // Attach GCS bootstrap info only on the first message for this producer session
    if (!gcsBootstrapSent && gcsTokenToUse) {
      forwardEvt.gcs = { bucket: GCS_BUCKET, prefix: gcsPrefix, token: gcsTokenToUse };
      gcsBootstrapSent = true;
    }

    console.log('[producer] -> consumer send', { id: evt.id, tool, hasCallback: !!evt?.callback_id });

    let payload = null;
    try {
      payload = await consumer.send(forwardEvt, { timeoutMs: Math.max(15000, EVENTS_HEARTBEAT_MS * 2) });
      console.log('[producer] <- consumer result', { id: evt.id, ok: true, hasResult: payload != null });
    } catch (err) {
      console.warn('[producer] consumer send failed', { id: evt.id, error: err?.message || err });
      // Do not advance/commit cursor; allow reconnect to pick up from committedEventId
      return false;
    }

    // Extract tool result and error (tool-level). Payload may be { result, error } or raw result.
    let toolResult = null;
    let toolError = undefined;
    if (payload && typeof payload === 'object') {
      if (Object.prototype.hasOwnProperty.call(payload, 'result')) toolResult = payload.result;
      if (Object.prototype.hasOwnProperty.call(payload, 'error')) toolError = payload.error;
    } else {
      toolResult = payload; // in case consumer returned raw result
    }

    // Post callback if requested. Include error so the agent can react, but keep compatibility:
    // - If no error: send just result
    // - If error present: send { result, error }
    if (evt?.callback_id) {
      const cbPayload = (toolError !== undefined)
        ? { result: toolResult ?? null, error: toolError }
        : toolResult;
      try {
        await withRetries(() => postCallback(evt.callback_id, cbPayload), {
          attempts: 3,
          baseDelayMs: 300,
          label: 'callback-post',
          // Do not retry on explicit 404/expired signals
          shouldRetry: (err) => (err?.status ?? err?.response?.status) !== 404 && err?.noRetry !== true,
        });
        console.log('[producer] callback posted', { id: evt.id, callbackId: evt.callback_id, hasError: toolError !== undefined });
      } catch (err) {
        if (err?.status === 404 || err?.noRetry) {
          console.warn('[producer] callback expired (404); skipping retries and proceeding to commit', { id: evt.id, callbackId: evt.callback_id });
          // proceed to cursor commit
        } else {
          console.warn('[producer] callback post failed; will not commit cursor', { id: evt.id, callbackId: evt.callback_id, error: err?.message || err });
          // Do not commit; rely on reconnect/resume to retry event and callback
          return false;
        }
      }
    }

    // Update project-wide cursor AFTER consumer response and (if applicable) successful callback
    const cursorTs = evt.create_time || evt.time || Date.now();
    try {
      await withRetries(() => postCursor({ eventId: evt.id || '', timestamp: cursorTs }), { attempts: 3, baseDelayMs: 300, label: 'cursor-post' });
      committedEventId = evt.id || committedEventId; // advance committed cursor only after persist
      console.log('[producer] cursor committed', { committedEventId, ts: cursorTs });
      return true;
    } catch (err) {
      console.warn('[producer] failed to commit cursor; will retry on next delivery', { id: evt.id, error: err?.message || err });
      return false;
    }
  }

  await connectEvents();
}

run().catch((err) => {
  console.error('[producer] fatal', err);
  gracefulShutdown(1, 'fatal');
});
