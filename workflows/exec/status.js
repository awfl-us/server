import { latestSessionExecutions } from './statusService.js';
import express from 'express';
import { getFirestore } from 'firebase-admin/firestore';
import { getUserIdFromReq, projectScopedCollectionPath } from '../utils.js';
import { COLLECTIONS, toSeconds } from './shared.js';

const router = express.Router();

// GET /workflows/exec/status/:execId
// Returns the stored status for a single execution id, or 404 if not found
router.get('/status/:execId', async (req, res) => {
  try {
    const userId = await getUserIdFromReq(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { execId } = req.params || {};
    if (!execId) return res.status(400).json({ error: 'Missing execId' });

    const db = getFirestore();
    const statusesCollection = projectScopedCollectionPath(userId, req.projectId, COLLECTIONS.statuses);
    const ref = db.collection(statusesCollection).doc(String(execId));
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Not found' });
    return res.status(200).json({ id: snap.id, data: snap.data() });
  } catch (err) {
    console.error('Error getting exec status:', err);
    return res.status(500).json({ error: 'Failed to get exec status', details: err?.message || String(err) });
  }
});

// GET /workflows/exec/status/latest/:sessionId?limit=5
// Returns the latest N exec registrations for a session, each with its current status.
// Note: Sub-workflow executions without a defined status are skipped so that the returned list
// contains only "real" statuses in created-desc order. When limit=1, the single item is the
// most recent defined status for the session.
router.get('/status/latest/:sessionId', async (req, res) => {
  try {
    const userId = await getUserIdFromReq(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { sessionId } = req.params || {};
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'Missing required param: sessionId' });
    }

    const limitRaw = req.query?.limit;
    let limit = Number(limitRaw);
    if (!Number.isFinite(limit) || limit <= 0) limit = 5;
    if (limit > 50) limit = 50; // defensive cap on returned items

    const { items, hasRegistrations } = await latestSessionExecutions({
      db: getFirestore(), userId, projectId: req.projectId,
      sessionId, limit, includeMetadata: true,
    });
    if (!hasRegistrations) return res.status(404).json({ error: 'No executions found for session' });
    return res.status(200).json({ sessionId, limit, items });
  } catch (err) {
    console.error('Error getting latest exec statuses:', err);
    return res.status(500).json({ error: 'Failed to get latest exec statuses', details: err?.message || String(err) });
  }
});

export default router;
