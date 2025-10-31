import express from 'express';
import { projectsCol, projectDoc, has, asBool, normalizeGitRemote } from './util.js';

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
    if (!remote || typeof remote !== 'string') return res.status(400).json({ error: 'remote is required' });

    const col = projectsCol(userId);
    const docRef = col.doc();
    const now = Date.now();

    const data = {
      id: docRef.id,
      remote: normalizeGitRemote(remote),
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

// Delete a project (cleans up known integration docs)
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });
    const { id } = req.params;

    const ref = projectDoc(userId, id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Project not found' });

    // Best-effort delete of GitHub integration doc to mirror gitFiles structure
    const db = ref.firestore;
    const batch = db.batch();
    batch.delete(ref.collection('integrations').doc('github'));
    batch.delete(ref);
    await batch.commit();

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[projects] delete failed', err);
    return res.status(500).json({ error: 'Failed to delete project' });
  }
});

export default router;
