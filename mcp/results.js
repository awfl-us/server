import express from 'express';
import { ExecutionService, validId } from './service.js';
import { getFirestore } from 'firebase-admin/firestore';

// Reuse the ordinary Firebase/project middleware for consumer callbacks.
// Atomic claims prevent duplicate command execution after SSE replay.
export function createMcpResultsRouter(service = new ExecutionService({ db: getFirestore() })) {
  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));
  router.post('/:workspaceId/:requestId/claim', async (req, res) => {
    const id = req.params.workspaceId;
    const seq = Number(req.params.requestId);
    if (!validId(id) || !Number.isSafeInteger(seq) || seq < 1 || seq > 2000) {
      return res.status(400).json({ error: 'Invalid request' });
    }
    try {
      return res.status(200).json(await service.claim(req.userId, req.projectId, id, seq));
    } catch (e) {
      return res.status(403).json({ error: e.publicMessage || 'Request inaccessible' });
    }
  });
  router.post('/:workspaceId/:requestId/result', async (req, res) => {
    const id = req.params.workspaceId;
    const seq = Number(req.params.requestId);
    if (!validId(id) || !Number.isSafeInteger(seq) || seq < 1 || seq > 2000 ||
        !req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Invalid result' });
    }
    try {
      const result = await service.complete(req.userId, req.projectId, id, seq, req.body);
      return res.status(result.ok ? 200 : 409).json(result);
    } catch (e) {
      return res.status(403).json({ error: e.publicMessage || 'Request inaccessible' });
    }
  });
  return router;
}
