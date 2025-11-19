import { checkInboundAuth } from '../auth.js';
import { ensureWorkRoot } from '../storage.js';
import { createHandlers } from '../sse/consumer.js';
import { EVENTS_HEARTBEAT_MS, SYNC_ON_START, GCS_BUCKET, GCS_PREFIX_TEMPLATE, SYNC_INTERVAL_MS } from '../config.js';
import { syncBucketPrefix } from '../gcs-sync.js';

function sanitizeHeaders(h) {
  const out = { ...h };
  if (out.authorization) out.authorization = '[redacted]';
  if (out['x-service-auth']) out['x-service-auth'] = '[redacted]';
  if (out['x-gcs-token']) out['x-gcs-token'] = '[redacted]';
  return out;
}

function renderPrefixTemplate(tpl, ctx) {
  const safe = String(tpl || '');
  return safe.replace(/\{(userId|projectId|workspaceId|sessionId)\}/g, (_, k) => String(ctx[k] || ''));
}

export function registerStreamRoute(app) {
  app.post('/sessions/stream', async (req, res) => {
    // Connection diagnostics
    try {
      const sock = req.socket;
      const safeHeaders = sanitizeHeaders(req.headers || {});
      // eslint-disable-next-line no-console
      console.log('[consumer] ← inbound /sessions/stream', {
        method: req.method,
        url: req.originalUrl || req.url,
        headers: safeHeaders,
        remote: { address: sock?.remoteAddress, port: sock?.remotePort },
        local: { address: sock?.localAddress, port: sock?.localPort },
      });
    } catch (_) {}

    if (!checkInboundAuth(req, res)) return;

    const userId = req.headers['x-user-id'] || req.query.userId;
    const projectId = req.headers['x-project-id'] || req.query.projectId;
    const workspaceId = req.headers['x-workspace-id'] || req.query.workspaceId;
    const sessionId = req.headers['x-session-id'] || req.query.sessionId;

    if (!userId || !projectId) {
      res.status(400).json({ error: 'missing userId/projectId' });
      return;
    }

    // Anti-buffering/keepalive headers and disable timeouts
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Keep-Alive', 'timeout=120, max=1000');

    try { req.setTimeout(0); } catch {}
    try { res.setTimeout(0); } catch {}
    try { res.flushHeaders?.(); } catch {}
    try { res.socket?.setKeepAlive?.(true, Math.max(10000, EVENTS_HEARTBEAT_MS)); } catch {}

    let workRoot;
    try {
      workRoot = await ensureWorkRoot({ userId, projectId, workspaceId, sessionId });
      // eslint-disable-next-line no-console
      console.log('[consumer] work root ready', { workRoot, userId, projectId, workspaceId, sessionId });
    } catch (err) {
      try { res.write(`${JSON.stringify({ error: 'work_root_error', message: err?.message })}\n`); } catch {}
      return void res.end();
    }

    // Compute GCS sync inputs
    const gcsToken = (req.headers['x-gcs-token'] || '').toString();
    const gcsBucket = GCS_BUCKET;
    const gcsPrefix = renderPrefixTemplate(GCS_PREFIX_TEMPLATE, { userId, projectId, workspaceId, sessionId });

    // Periodic sync management
    let syncIv = null;
    let syncing = false;
    let closed = false;

    async function runSync(kind = 'manual', { suppressWrite = false } = {}) {
      if (!gcsBucket) return;
      if (syncing) return; // avoid overlapping runs
      syncing = true;
      // eslint-disable-next-line no-console
      console.log('[consumer] gcs sync start', { bucket: gcsBucket, prefix: gcsPrefix, tokenProvided: Boolean(gcsToken), kind });
      try {
        const stats = await syncBucketPrefix({ bucket: gcsBucket, prefix: gcsPrefix, workRoot, token: gcsToken });
        // eslint-disable-next-line no-console
        console.log('[consumer] gcs sync done', { stats, kind });
        if (!suppressWrite) {
          try { res.write(`${JSON.stringify({ type: 'gcs_sync', stats, kind })}\n`); } catch {}
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[consumer] gcs sync error', err?.message || err);
        if (!suppressWrite) {
          try { res.write(`${JSON.stringify({ type: 'gcs_sync_error', error: err?.message || String(err), kind })}\n`); } catch {}
        }
      } finally {
        syncing = false;
      }
    }

    // Optionally trigger initial sync on connect
    if (SYNC_ON_START && gcsBucket) {
      // fire and wait for first sync
      await runSync('start');
    } else {
      // eslint-disable-next-line no-console
      console.log('[consumer] gcs sync skipped', { SYNC_ON_START, bucketConfigured: Boolean(gcsBucket) });
    }

    // Set up periodic sync while stream is open
    if (gcsBucket && SYNC_INTERVAL_MS > 0) {
      syncIv = setInterval(() => { if (!closed) runSync('interval', { suppressWrite: false }); }, Math.max(1000, SYNC_INTERVAL_MS));
    }

    const { handleLine } = createHandlers({ workRoot, res, gcs: { bucket: gcsBucket, prefix: gcsPrefix, token: gcsToken } });

    // Heartbeat pings back to producer
    try { res.write(`ready ${Date.now()}\n`); } catch {}
    const pingIv = setInterval(() => {
      try { res.write(`ping ${Date.now()}\n`); } catch {}
    }, EVENTS_HEARTBEAT_MS);

    // Stream in request lines (NDJSON) and handle them
    req.setEncoding('utf8');
    let buffer = '';
    let linesCount = 0;

    function flushLines() {
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        linesCount++;
        handleLine(line);
      }
    }

    req.on('data', (chunk) => {
      buffer += chunk;
      flushLines();
    });

    // Do NOT end the response when the request finishes writing; keep the server->client
    // stream open until the socket actually closes. Just flush any remaining buffered line.
    req.on('end', async () => {
      if (buffer.trim()) { linesCount++; await handleLine(buffer); buffer = ''; }
      // eslint-disable-next-line no-console
      console.log('[consumer] producer finished writing (req end)', { linesCount });
      // keep response open; heartbeats continue until close/aborted/error
    });

    function cleanupAndClose(reason) {
      closed = true;
      try { clearInterval(pingIv); } catch {}
      try { if (syncIv) clearInterval(syncIv); } catch {}
      // Final sync on shutdown if bucket configured
      // Fire and forget to avoid blocking close; we also suppress response writes since stream is closing
      if (gcsBucket) {
        try { runSync('shutdown', { suppressWrite: true }); } catch {}
      }
      // eslint-disable-next-line no-console
      console.log('[consumer] closing stream', { reason, linesCount });
      try { res.end(); } catch {}
    }

    req.on('error', (e) => {
      // eslint-disable-next-line no-console
      console.warn('[consumer] request error', e?.message || e);
      cleanupAndClose('req_error');
    });

    req.on('aborted', () => {
      // eslint-disable-next-line no-console
      console.warn('[consumer] request aborted by client');
      cleanupAndClose('aborted');
    });

    // End the response only when the response is closed (client stopped reading) or the socket closes
    res.on('close', () => {
      cleanupAndClose('res_close');
    });
  });
}
