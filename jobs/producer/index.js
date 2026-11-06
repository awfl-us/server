import express from 'express';
import { startProjectConsumer } from './start.js';
import { getConsumerLock, releaseConsumerLock } from '../../workflows/projects/lock.js';
import { stopByRuntime } from './paths/stop.js';
import { cancelStartupProgress } from './progress.js';

const router = express.Router();
router.use(express.json());

// Shared lifecycle for the regular API and MCP attachment.
router.post('/start', async (req, res) => {
  const result = await startProjectConsumer({ userId: req.userId, projectId: req.projectId, body: req.body || {} });
  return res.status(result.status).json(result.body);
});

// POST /jobs/producer/stop
router.post('/stop', async (req, res) => {
  try {
    const userId = req.userId;
    const projectId = req.projectId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing user context' });
    if (!projectId) return res.status(400).json({ error: 'Missing x-project-id header' });

    try { cancelStartupProgress({ userId, projectId, reason: 'stop requested' }); } catch {}

    const { ok, lock } = await getConsumerLock({ userId, projectId });
    if (!ok) return res.status(500).json({ error: 'Failed to read lock' });
    if (!lock) return res.status(200).json({ ok: true, message: 'No active lock' });

    const { status, body } = await stopByRuntime({ userId, projectId, lock });
    return res.status(status).json(body);
  } catch (err) {
    console.error('[jobs/producer:stop] error', err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

export default router;
