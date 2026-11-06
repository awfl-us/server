import express from 'express';
import { createSSEConnection } from '../workflows/events/sse.js';

export function createConsumerRouter(service) {
  const router = express.Router();
  router.use('/:id', async (req, res, next) => {
    try {
      const token = /^Bearer (\S+)$/.exec(req.get('authorization') || '')?.[1];
      const ws = await service.consumer(req.params.id, token);
      if (!ws) return res.status(401).json({ error: 'Workspace credential invalid or expired' });
      req.executionWorkspace = ws;
      req.executionId = req.params.id;
      next();
    } catch { res.status(503).json({ error: 'Workspace verification unavailable' }); }
  });
  router.get('/:id/stream', async (req, res) => {
    const cursor = Number(req.get('last-event-id') || 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > req.executionWorkspace.nextSeq) return res.status(400).json({ error: 'Invalid cursor' });
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const sse = createSSEConnection(res);
    const ref = service.ref(req.executionId);
    let unsub = () => {};
    let watch = () => {};
    let closed = false;
    const close = () => { if (closed) return; closed = true; clearTimeout(expiry); unsub(); watch(); sse.close(); };
    const expiry = setTimeout(close, Math.max(1, req.executionWorkspace.expiresAt - Date.now()));
    res.on('close', close);
    // Workspace revocation terminates existing streams, not just reconnects.
    watch = ref.onSnapshot(snap => { if (!snap.exists || snap.data().stopped) close(); }, close);
    unsub = ref.collection('mcpRequests').orderBy('seq').startAfter(cursor).onSnapshot(snapshot => {
      for (const change of snapshot.docChanges()) {
        if (change.type !== 'added') continue;
        const request = change.doc.data();
        if (!sse.sendEvent({ id: request.seq, data: request.data })) { close(); break; }
      }
    }, close);
    await ref.update({ state: 'ready' }).catch(close);
  });
  router.post('/:id/results/:seq', async (req, res) => {
    const seq = Number(req.params.seq);
    if (!Number.isSafeInteger(seq) || seq < 1 || seq > req.executionWorkspace.nextSeq) return res.status(400).json({ error: 'Invalid request ID' });
    if (!req.body || Array.isArray(req.body) || Buffer.byteLength(JSON.stringify(req.body)) > 200000) return res.status(413).json({ error: 'Result exceeds limit' });
    try {
      const ref = service.ref(req.executionId);
      const request = ref.collection('mcpRequests').doc(String(seq).padStart(8, '0'));
      await service.db.runTransaction(async tx => {
        const [ws, record] = await Promise.all([tx.get(ref), tx.get(request)]);
        if (ws.data().stopped || ws.data().expiresAt <= Date.now() || !record.exists) throw new Error('Gone');
        if (record.data().result === undefined) tx.update(request, { result: req.body });
        tx.update(ref, { ackSeq: Math.max(seq, ws.data().ackSeq || 0), lastCallbackAt: Date.now() });
      });
      res.json({ ok: true });
    } catch { res.status(503).json({ error: 'Callback unavailable' }); }
  });
  return router;
}
