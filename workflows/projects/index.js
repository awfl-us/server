import express from 'express';
import { projectsCol, projectDoc, has, asBool, normalizeGitRemote } from './util.js';
import { acquireConsumerLock, releaseConsumerLock, getConsumerLockStatus } from './lock.js';

const router = express.Router();
router.use(express.json());

// Create a project
// Body: { remote: string, name?: string, live?: boolean }
router.post('/', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });

    const { remote, name } = req.body || {};
    let { live } = req.body || {};

    const col = projectsCol(userId);
    const docRef = col.doc();
    const now = Date.now();

    const data = {
      id: docRef.id,
      remote: remote ? normalizeGitRemote(remote) : null,
      ...(has(name) ? { name: String(name).trim() } : {}),
      live: asBool(live, false),
      created: now,
      updated: now,
    };

    await docRef.set(data, { merge: true });
    return res.status(201).json({ project: data });
  } catch (err) {
    console.error('[projects] create failed', err);
    return res.status(500).json({ error: 'Failed to create project' });
  }
});

// List projects
router.get('/', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });

    const { limit = 50, order = 'desc' } = req.query || {};
    const q = projectsCol(userId)
      .orderBy('created', order === 'asc' ? 'asc' : 'desc')
      .limit(Math.min(Number(limit) || 50, 200));

    const snap = await q.get();
    const projects = snap.docs.map(d => d.data());
    return res.status(200).json({ projects });
  } catch (err) {
    console.error('[projects] list failed', err);
    return res.status(500).json({ error: 'Failed to list projects' });
  }
});

// Get a project
router.get('/:id', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });
    const { id } = req.params;
    const ref = projectDoc(userId, id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Project not found' });
    return res.status(200).json({ project: snap.data() });
  } catch (err) {
    console.error('[projects] get failed', err);
    return res.status(500).json({ error: 'Failed to get project' });
  }
});

// Update a project
// Body: { remote?, name?, live? }
router.patch('/:id', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });
    const { id } = req.params;
    const { remote, name } = req.body || {};
    let { live } = req.body || {};

    const ref = projectDoc(userId, id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Project not found' });

    const updates = { updated: Date.now() };
    if (has(remote)) updates.remote = normalizeGitRemote(String(remote));
    if (has(name)) updates.name = String(name).trim();
    if (has(live)) updates.live = asBool(live, false);

    await ref.set(updates, { merge: true });
    const after = await ref.get();
    return res.status(200).json({ project: after.data() });
  } catch (err) {
    console.error('[projects] update failed', err);
    return res.status(500).json({ error: 'Failed to update project' });
  }
});

// Delete a project
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });
    const { id } = req.params;

    const ref = projectDoc(userId, id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Project not found' });

    await ref.delete();
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[projects] delete failed', err);
    return res.status(500).json({ error: 'Failed to delete project' });
  }
});

// Obtain or refresh a consumer lock for a project
// Endpoint: POST /:id/consumer-lock/acquire
// Headers (optional): x-consumer-id, x-lock-lease-ms, x-consumer-type
// Body: { consumerId?: string, leaseMs?: number, consumerType?: 'LOCAL' | 'CLOUD' }
router.post('/:id/consumer-lock/acquire', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });
    const { id } = req.params;

    const consumerId = (req.body?.consumerId || req.header('x-consumer-id') || '').toString().trim();
    if (!consumerId) return res.status(400).json({ error: 'consumerId required (body.consumerId or x-consumer-id)' });

    const rawLease = Number(req.body?.leaseMs ?? req.header('x-lock-lease-ms'));
    const leaseMs = Number.isFinite(rawLease) ? Math.floor(rawLease) : undefined; // clamp inside util

    const rawType = (req.body?.consumerType || req.header('x-consumer-type') || '').toString().trim().toUpperCase();

    const result = await acquireConsumerLock({ userId, projectId: id, consumerId, leaseMs, consumerType: rawType });
    if (result.conflict) return res.status(409).json(result);
    return res.status(200).json(result);
  } catch (err) {
    if (err?.code === 404) return res.status(404).json({ error: 'Project not found' });
    console.error('[projects] consumer-lock acquire failed', err);
    return res.status(500).json({ error: 'Failed to acquire consumer lock' });
  }
});

// Release a consumer lock
// Endpoint: POST /:id/consumer-lock/release
// Headers (optional): x-consumer-id; Body: { consumerId?: string, force?: boolean }
router.post('/:id/consumer-lock/release', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });
    const { id } = req.params;

    const consumerId = (req.body?.consumerId || req.header('x-consumer-id') || '').toString().trim();
    const force = req.body?.force ?? req.header('x-lock-force');
    if (!consumerId && !asBool(force, false)) return res.status(400).json({ error: 'consumerId required unless force=true' });

    const status = await releaseConsumerLock({ userId, projectId: id, consumerId: consumerId || undefined, force });
    if (status.conflict) return res.status(409).json(status);
    return res.status(200).json(status);
  } catch (err) {
    if (err?.code === 404) return res.status(404).json({ error: 'Project not found' });
    console.error('[projects] consumer-lock release failed', err);
    return res.status(500).json({ error: 'Failed to release consumer lock' });
  }
});

// Get consumer lock status
// Endpoint: GET /:id/consumer-lock/status
router.get('/:id/consumer-lock/status', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });
    const { id } = req.params;

    const status = await getConsumerLockStatus({ userId, projectId: id });
    return res.status(200).json(status);
  } catch (err) {
    if (err?.code === 404) return res.status(404).json({ error: 'Project not found' });
    console.error('[projects] consumer-lock status failed', err);
    return res.status(500).json({ error: 'Failed to get consumer lock status' });
  }
});

export default router;
