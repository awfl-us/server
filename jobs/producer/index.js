import express from 'express';
import { startProjectConsumer } from './start.js';
import { stopProjectConsumer } from './stop.js';
import { consumerImageCatalog } from './imageProfiles.js';

const router = express.Router();
router.use(express.json());

// Catalog reflects which immutable image profiles the current deployment has
// actually published. Shared by the web selector and API consumers.
router.get('/images', (_req, res) => res.json(consumerImageCatalog()));

// Shared lifecycle for the regular API and MCP attachment.
router.post('/start', async (req, res) => {
  const result = await startProjectConsumer({ userId: req.userId, projectId: req.projectId, body: req.body || {} });
  return res.status(result.status).json(result.body);
});

// POST /jobs/producer/stop -- same shutdown implementation as MCP.
router.post('/stop', async (req, res) => {
  try {
    const result = await stopProjectConsumer({ userId: req.userId, projectId: req.projectId });
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[jobs/producer:stop] error', err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

export default router;
