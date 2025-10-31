import express from 'express';
import { getFirestore } from 'firebase-admin/firestore';
import { projectScopedCollectionPath } from './utils.js';

const VALID_STATUSES = ['Queued', 'In Progress', 'Done', 'Stuck'];

function validateStatus(status) {
  return VALID_STATUSES.includes(status);
}

// Creates a Tasks router. By default, requires upstream middleware to have set req.userId.
export function createTasksRouter() {
  const router = express.Router();
  router.use(express.json());

  const db = getFirestore();

  // Pre-auth guard: ensure req.userId is present (set by clientAuth or workflowsUserInject upstream)
  router.use((req, res, next) => {
    const userId = req?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });
    next();
  });

  // Create task
  router.post('/', async (req, res) => {
    try {
      const userId = req.userId;
      const { sessionId, title, description, status } = req.body || {};
      if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
      if (status && !validateStatus(status)) return res.status(400).json({ error: `Invalid status. Must be one of ${VALID_STATUSES.join(', ')}` });

      const colPath = projectScopedCollectionPath(userId, req.projectId, 'tasks');
      const colRef = db.collection(colPath);
      const now = Date.now();
      const docRef = colRef.doc();
      const data = {
        id: docRef.id,
        sessionId,
        title: title || null,
        description: description || null,
        status: status || 'Queued',
        created: now,
        updated: now,
      };
      await docRef.set(data, { merge: true });
      return res.status(201).json({ task: data });
    } catch (err) {
      console.error('[tasks] create failed', err);
      return res.status(500).json({ error: 'Failed to create task' });
    }
  });

  // Read a task
  router.get('/:id', async (req, res) => {
    try {
      const userId = req.userId;
      const { id } = req.params;
      const docRef = db.doc(projectScopedCollectionPath(userId, req.projectId, `tasks/${id}`));
      const snap = await docRef.get();
      if (!snap.exists) return res.status(404).json({ error: 'Task not found' });
      return res.status(200).json({ task: snap.data() });
    } catch (err) {
      console.error('[tasks] get failed', err);
      return res.status(500).json({ error: 'Failed to get task' });
    }
  });

  // Update a task
  router.patch('/:id', async (req, res) => {
    try {
      const userId = req.userId;
      const { id } = req.params;
      const { sessionId, title, description, status } = req.body || {};

      const has = (v) => v !== undefined && v !== null;
      if (has(status) && !validateStatus(status)) {
        return res.status(400).json({ error: `Invalid status. Must be one of ${VALID_STATUSES.join(', ')}` });
      }

      const docRef = db.doc(projectScopedCollectionPath(userId, req.projectId, `tasks/${id}`));
      const snap = await docRef.get();
      if (!snap.exists) return res.status(404).json({ error: 'Task not found' });

      const updates = { updated: Date.now() };
      if (has(sessionId)) updates.sessionId = sessionId;
      if (has(title)) updates.title = title;
      if (has(description)) updates.description = description;
      if (has(status)) updates.status = status;
      // Ignore extra fields and any null-valued fields to avoid accidental clearing

      await docRef.set(updates, { merge: true });
      const after = await docRef.get();
      return res.status(200).json({ task: after.data() });
    } catch (err) {
      console.error('[tasks] update failed', err);
      return res.status(500).json({ error: 'Failed to update task' });
    }
  });

  // Update task status (explicit endpoint)
  router.post('/:id/status', async (req, res) => {
    try {
      const userId = req.userId;
      const { id } = req.params;
      const { status } = req.body || {};
      if (!status) return res.status(400).json({ error: 'status is required' });
      if (!validateStatus(status)) return res.status(400).json({ error: `Invalid status. Must be one of ${VALID_STATUSES.join(', ')}` });

      const docRef = db.doc(projectScopedCollectionPath(userId, req.projectId, `tasks/${id}`));
      const snap = await docRef.get();
      if (!snap.exists) return res.status(404).json({ error: 'Task not found' });

      await docRef.set({ status, updated: Date.now() }, { merge: true });
      const after = await docRef.get();
      return res.status(200).json({ task: after.data() });
    } catch (err) {
      console.error('[tasks] status update failed', err);
      return res.status(500).json({ error: 'Failed to update status' });
    }
  });

  // Delete a task
  router.delete('/:id', async (req, res) => {
    try {
      const userId = req.userId;
      const { id } = req.params;
      const docRef = db.doc(projectScopedCollectionPath(userId, req.projectId, `tasks/${id}`));
      const snap = await docRef.get();
      if (!snap.exists) return res.status(404).json({ error: 'Task not found' });
      await docRef.delete();
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[tasks] delete failed', err);
      return res.status(500).json({ error: 'Failed to delete task' });
    }
  });

  // List tasks for user (optionally by sessionId and/or status)
  router.get('/', async (req, res) => {
    try {
      const userId = req.userId;
      const { sessionId, status, limit = 50, order = 'desc' } = req.query || {};
      if (status && !validateStatus(status)) return res.status(400).json({ error: `Invalid status. Must be one of ${VALID_STATUSES.join(', ')}` });

      let q = db.collection(projectScopedCollectionPath(userId, req.projectId, 'tasks'));
      if (sessionId) q = q.where('sessionId', '==', sessionId);
      if (status) q = q.where('status', '==', status);
      q = q.orderBy('created', order === 'asc' ? 'asc' : 'desc').limit(Math.min(Number(limit) || 50, 200));

      const snap = await q.get();
      const tasks = snap.docs.map(d => d.data());
      return res.status(200).json({ tasks });
    } catch (err) {
      console.error('[tasks] list failed', err);
      return res.status(500).json({ error: 'Failed to list tasks' });
    }
  });

  // List by session explicitly
  router.get('/by-session/:sessionId', async (req, res) => {
    try {
      const userId = req.userId;
      const { sessionId } = req.params;
      const { status, limit = 50, order = 'desc' } = req.query || {};
      if (status && !validateStatus(status)) return res.status(400).json({ error: `Invalid status. Must be one of ${VALID_STATUSES.join(', ')}` });

      let q = db.collection(projectScopedCollectionPath(userId, req.projectId, 'tasks'))
        .where('sessionId', '==', sessionId)
        .orderBy('created', order === 'asc' ? 'asc' : 'desc')
        .limit(Math.min(Number(limit) || 50, 200));
      if (status) q = q.where('status', '==', status);

      const snap = await q.get();
      const tasks = snap.docs.map(d => d.data());
      return res.status(200).json({ tasks });
    } catch (err) {
      console.error('[tasks] list by session failed', err);
      return res.status(500).json({ error: 'Failed to list tasks by session' });
    }
  });

  // Metadata endpoint
  router.get('/meta/statuses', (_req, res) => {
    return res.status(200).json({ statuses: VALID_STATUSES });
  });

  return router;
}
