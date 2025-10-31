import express from 'express';
import { normalizeEnvelope, parseBool, pickBackend } from './model.js';
import { createSSEConnection } from './sse.js';
import { metrics, incCounter } from './metrics.js';
import { getFirestore } from 'firebase-admin/firestore';
import { projectScopedCollectionPath } from '../userAuth.js';
import cursorsRouter from './cursors.js';

const router = express.Router();
router.use(express.json({ limit: process.env.RELAY_EVENT_MAX_BYTES || '64kb' }));

// Mount sub-services
router.use('/cursors', cursorsRouter);

// NOTE: Auth is applied at the workflows router level via shared clientAuth. This router assumes req.userId is already set when required.

function has(v) { return v !== undefined && v !== null; }
function parseTtlMs(q) {
  const ttlMsParam = q.ttlMs ?? q.ttl_ms ?? q.ttlms;
  const ttlSecParam = q.ttlSec ?? q.ttl_sec ?? q.ttl;
  let ttlMs = undefined;
  if (has(ttlMsParam)) ttlMs = Number(ttlMsParam);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    const asSec = has(ttlSecParam) ? Number(ttlSecParam) : undefined;
    if (Number.isFinite(asSec) && asSec > 0) ttlMs = asSec * 1000;
  }
  // Default TTL: 5 minutes
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) ttlMs = 5 * 60 * 1000;
  return Math.floor(ttlMs);
}

// Health and metrics
router.get('/healthz', (req, res) => {
  const b = pickBackend(req.userId, req.projectId);
  res.status(200).json({ ok: true, backend: b.kind });
});
router.get('/readyz', (req, res) => {
  const b = pickBackend(req.userId, req.projectId);
  res.status(200).json({ ready: true, backend: b.kind });
});
router.get('/metrics', async (req, res) => {
  res.set('Content-Type', metrics.contentType);
  res.send(await metrics.metrics());
});

// POST / — ingest a single event envelope
router.post('/', async (req, res) => {
  try {
    const backend = pickBackend(req.userId, req.projectId);
    const env = normalizeEnvelope(req.body || {});

    // Size guard (post-JSON parse)
    const maxBytes = Number(process.env.RELAY_EVENT_MAX_BYTES || 65536);
    const payloadSize = Buffer.byteLength(JSON.stringify(env?.data || {}));
    if (payloadSize > maxBytes) {
      return res.status(413).json({ error: 'Event too large', max: maxBytes });
    }

    await backend.append(env);
    incCounter('relay_events_ingested_total');

    res.status(201).json({ id: env.id, stored: true, persistence: backend.kind, sessionId: env.sessionId, create_time: env.create_time });
  } catch (err) {
    console.error('[events POST] error', err);
    res.status(400).json({ error: String(err?.message || err) });
  }
});

// GET / — fetch a page for debugging/offline use
router.get('/', async (req, res) => {
  try {
    const backend = pickBackend(req.userId, req.projectId);
    const sessionId = String(req.query.sessionId || '').trim();
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    const since_id = req.query.since_id ? String(req.query.since_id) : null;
    const since_time = req.query.since_time ? String(req.query.since_time) : null;
    const limit = Math.min(Number(req.query.limit || process.env.RELAY_REPLAY_LIMIT || 500), 2000);

    let items = [];
    if (since_id) {
      items = await backend.replayByUlid(sessionId, since_id, limit);
    } else if (since_time) {
      items = await backend.replayByTime(sessionId, since_time, limit);
    } else {
      // If no cursor, return the most recent up to limit
      items = await backend.recent(sessionId, limit);
    }

    res.json(items);
  } catch (err) {
    console.error('[events GET] error', err);
    res.status(400).json({ error: String(err?.message || err) });
  }
});

// GET /stream — Server-Sent Events stream
router.get('/stream', async (req, res) => {
  try {
    const userId = req.userId;
    const backend = pickBackend(userId, req.projectId);
    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');

    const workspaceId = String(req.query.workspaceId || req.query.workspace_id || '').trim();
    // const sessionIdLegacy = String(req.query.sessionId || '').trim();

    const heartbeatMs = Math.max(Number(req.query.heartbeat_ms || process.env.RELAY_HEARTBEAT_MS || 15000), 1000);
    const lastEventId = req.get('Last-Event-ID');
    const since_id = req.query.since_id ? String(req.query.since_id) : null;
    const since_time = req.query.since_time ? String(req.query.since_time) : null;

    console.log("Last event ID:", lastEventId);

    const sse = createSSEConnection(res, { heartbeatMs });

    // Workspace-scoped streaming (preferred)
    if (workspaceId) {
      if (!userId) {
        res.status(401).end('event: error\ndata: {"error":"Unauthorized: missing req.userId"}\n\n');
        return;
      }

      const db = getFirestore();
      const wsPath = projectScopedCollectionPath(userId, req.projectId, `workspaces/${workspaceId}`);
      const wsRef = db.doc(wsPath);
      const wsSnap = await wsRef.get();
      if (!wsSnap.exists) {
        res.status(404).end('event: error\ndata: {"error":"workspace not found"}\n\n');
        return;
      }
      const ws = wsSnap.data() || {};
      const ttlMs = parseTtlMs(req.query || {});
      const cutoff = Date.now() - ttlMs;
      if (!ws.live_at || ws.live_at < cutoff) {
        res.status(404).end('event: error\ndata: {"error":"workspace not live"}\n\n');
        return;
      }
      // const projectId = String(ws.projectId || '').trim();
      // if (!projectId) {
      //   res.status(400).end('event: error\ndata: {"error":"workspace missing projectId"}\n\n');
      //   return;
      // }

      // Service-driven heartbeat for live workspace while the stream is open (opt-out with ?heartbeat=none)
      const heartbeatMode = String(req.query.heartbeat || '').trim().toLowerCase();
      const enableHeartbeat = heartbeatMode !== 'none';
      const heartbeatCadenceMs = Math.max(5000, Math.min(Math.floor(ttlMs / 3), 60000));
      let hbTimer = null;
      let lastHeartbeatWriteAt = 0;
      const writeHeartbeat = async (reason = 'interval') => {
        const now = Date.now();
        // Rate-limit to ~cadence; skip if we already wrote recently
        if (now - lastHeartbeatWriteAt < (heartbeatCadenceMs - 250)) return;
        try {
          await wsRef.update({ live_at: now });
          lastHeartbeatWriteAt = now;
          incCounter('relay_workspace_heartbeat_writes_total');
        } catch (e) {
          // Best-effort; log and continue
          console.warn('[events stream] workspace heartbeat update failed', { workspaceId, reason, error: String(e?.message || e) });
        }
      };

      if (enableHeartbeat) {
        // On connect: bump live_at immediately
        await writeHeartbeat('connect');
        // While open: refresh on a fixed cadence
        hbTimer = setInterval(() => { void writeHeartbeat('interval'); }, heartbeatCadenceMs);
      }

      // Determine filter mode based on workspace session binding
      const sessionId = typeof ws.sessionId === 'string' && ws.sessionId.trim().length > 0 ? ws.sessionId.trim() : null;

      // Prepare initial replay for project scope
      let replayItems = [];
      let lastSeenTime = null;
      if (lastEventId) {
        replayItems, lastSeenTime = await backend.replayProjectByUlid(lastEventId, Number(process.env.RELAY_REPLAY_LIMIT || 500));
      } else if (since_id) {
        replayItems, lastSeenTime = await backend.replayProjectByUlid(since_id, Number(process.env.RELAY_REPLAY_LIMIT || 500));
      } else if (since_time) {
        replayItems, lastSeenTime = await backend.replayProjectByTime(since_time, Number(process.env.RELAY_REPLAY_LIMIT || 500));
      }

      console.log("Last seen time: ", lastSeenTime)

      if (sessionId) {
        // Session-scoped workspace: include only that session's events. Background flag is ignored per new model.
        for (const ev of replayItems) {
          if (ev.sessionId !== sessionId) continue;
          sse.sendEvent(ev);
          lastSeenTime = ev.create_time;
        }
        if (replayItems?.length) incCounter('relay_events_replayed_total', replayItems.length);

        const unsub = await backend.subscribeProject((ev) => {
          if (ev.sessionId !== sessionId) return;
          const ok = sse.sendEvent(ev);
          if (!ok) {
            incCounter('relay_events_dropped_total');
            try { sse.close(); } catch {}
          } else {
            incCounter('relay_events_streamed_total');
          }
        }, { after_time: lastSeenTime });

        req.on('close', () => {
          try { unsub && unsub(); } catch {}
          try { sse.close(); } catch {}
          try { hbTimer && clearInterval(hbTimer); } catch {}
        });
      } else {
        // Project-wide workspace: send *all* project events (no filtering by live sessions)
        for (const ev of replayItems) {
          sse.sendEvent(ev);
          lastSeenTime = ev.create_time;
        }
        if (replayItems?.length) incCounter('relay_events_replayed_total', replayItems.length);

        // Subscribe to all future project events
        const unsub = await backend.subscribeProject((ev) => {
          const ok = sse.sendEvent(ev);
          if (!ok) {
            incCounter('relay_events_dropped_total');
            try { sse.close(); } catch {}
          } else {
            incCounter('relay_events_streamed_total');
          }
        }, { after_time: lastSeenTime });

        // Cleanup on connection close
        req.on('close', () => {
          try { unsub && unsub(); } catch {}
          try { sse.close(); } catch {}
          try { hbTimer && clearInterval(hbTimer); } catch {}
        });
      }

      return; // handled
    }

    // Legacy sessionId streaming
  //   const sessionId = sessionIdLegacy;
  //   if (!sessionId) {
  //     res.status(400).end('event: error\ndata: {"error":"workspaceId or sessionId required"}\n\n');
  //     return;
  //   }

  //   const includeBackground = parseBool(req.query.include_background, false);

  //   // Determine replay precedence: Last-Event-ID > since_id > since_time
  //   let replayItems = [];
  //   if (lastEventId) {
  //     replayItems = await backend.replayByUlid(sessionId, lastEventId, Number(process.env.RELAY_REPLAY_LIMIT || 500));
  //   } else if (since_id) {
  //     replayItems = await backend.replayByUlid(sessionId, since_id, Number(process.env.RELAY_REPLAY_LIMIT || 500));
  //   } else if (since_time) {
  //     replayItems = await backend.replayByTime(sessionId, since_time, Number(process.env.RELAY_REPLAY_LIMIT || 500));
  //   }

  //   let lastSeenTime = null;
  //   if (replayItems?.length) {
  //     for (const ev of replayItems) {
  //       if (!includeBackground && (ev.background || ev?.data?.payload?.background)) continue;
  //       sse.sendEvent(ev);
  //       lastSeenTime = ev.create_time;
  //     }
  //     incCounter('relay_events_replayed_total', replayItems.length);
  //   }

  //   // Subscribe to live events for this session
  //   const unsub = await backend.subscribe(sessionId, (ev) => {
  //     if (!includeBackground && (ev.background || ev?.data?.payload?.background)) return;
  //     // Backpressure: if write failed, close
  //     const ok = sse.sendEvent(ev);
  //     if (!ok) {
  //       incCounter('relay_events_dropped_total');
  //       try { sse.close(); } catch {}
  //     } else {
  //       incCounter('relay_events_streamed_total');
  //     }
  //   }, { after_time: lastSeenTime });

  //   // Close handling
  //   req.on('close', () => {
  //     try { unsub && unsub(); } catch {}
  //     try { sse.close(); } catch {}
  //   });
  } catch (err) {
    console.error('[events stream] error', err);
    try { res.end(); } catch {}
  }
});

export default router;
