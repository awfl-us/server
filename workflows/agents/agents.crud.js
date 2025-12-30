import express from 'express';
import { db, userScopedCollectionPath, loadFileDefinedAgents } from './common.js';

const router = express.Router();

function dedupeById(preferred = [], fallbacks = []) {
  const map = new Map();
  for (const a of preferred) {
    if (!a?.id) continue;
    map.set(a.id, a);
  }
  for (const a of fallbacks) {
    if (!a?.id) continue;
    if (!map.has(a.id)) map.set(a.id, a);
  }
  return Array.from(map.values());
}

// Create an agent
// Body: { name: string, description?: string, workflowName?: string, tools?: string[], inputSchema?: object }
router.post('/', async (req, res) => {
  try {
    const userId = req.userId;
    const { name, description, workflowName, tools, inputSchema } = req.body || {};
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name is required' });
    }

    const colRef = db.collection(userScopedCollectionPath(userId, 'agents'));
    const docRef = colRef.doc();
    const now = Date.now();

    const data = {
      id: docRef.id,
      name: name.trim(),
      description: typeof description === 'string' ? description : null,
      workflowName: typeof workflowName === 'string' ? workflowName.trim() : null,
      created: now,
      updated: now,
    };

    if (Array.isArray(tools) && tools.length) data.tools = tools;
    if (inputSchema && typeof inputSchema === 'object') data.inputSchema = inputSchema;

    await docRef.set(data, { merge: true });
    return res.status(201).json({ agent: data });
  } catch (err) {
    console.error('[agents] create failed', err);
    return res.status(500).json({ error: 'Failed to create agent' });
  }
});

// List agents (optionally limit/order) - includes file-defined agents from workflows/agents/defs
router.get('/', async (req, res) => {
  try {
    const userId = req.userId;
    const { limit = 50, order = 'desc' } = req.query || {};

    const q = db
      .collection(userScopedCollectionPath(userId, 'agents'))
      .orderBy('created', order === 'asc' ? 'asc' : 'desc')
      .limit(Math.min(Number(limit) || 50, 200));

    const snap = await q.get();
    const dbAgents = snap.docs.map((d) => d.data());

    const fileAgents = await loadFileDefinedAgents();
    const agents = dedupeById(dbAgents, fileAgents);

    return res.status(200).json({ agents });
  } catch (err) {
    console.error('[agents] list failed', err);
    return res.status(500).json({ error: 'Failed to list agents' });
  }
});

// Get a single agent - supports file-defined agents by id
router.get('/:id', async (req, res) => {
  try {
    const userId = req.userId;
    const { id } = req.params;
    const docRef = db.doc(userScopedCollectionPath(userId, `agents/${id}`));
    const snap = await docRef.get();
    if (snap.exists) {
      const agent = snap.data();
      return res.status(200).json({ agent });
    }

    // Fallback: file-defined
    const fileAgents = await loadFileDefinedAgents();
    const found = fileAgents.find(a => a.id === id);
    if (found) return res.status(200).json({ agent: found });

    return res.status(404).json({ error: 'Agent not found' });
  } catch (err) {
    console.error('[agents] get failed', err);
    return res.status(500).json({ error: 'Failed to get agent' });
  }
});

// Update an agent (name/description/workflowName/inputSchema)
router.patch('/:id', async (req, res) => {
  try {
    const userId = req.userId;
    const { id } = req.params;
    const { name, description, workflowName, inputSchema } = req.body || {};

    const has = (v) => v !== undefined && v !== null;

    const docRef = db.doc(userScopedCollectionPath(userId, `agents/${id}`));
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Agent not found' });

    const updates = { updated: Date.now() };
    if (has(name)) updates.name = String(name).trim();
    if (has(description)) updates.description = typeof description === 'string' ? description : null;
    if (has(workflowName)) updates.workflowName = typeof workflowName === 'string' ? workflowName.trim() : null;
    if (has(inputSchema)) updates.inputSchema = typeof inputSchema === 'object' ? inputSchema : null;

    await docRef.set(updates, { merge: true });
    const after = await docRef.get();
    return res.status(200).json({ agent: after.data() });
  } catch (err) {
    console.error('[agents] update failed', err);
    return res.status(500).json({ error: 'Failed to update agent' });
  }
});

// Delete an agent
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.userId;
    const { id } = req.params;

    const docRef = db.doc(userScopedCollectionPath(userId, `agents/${id}`));
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Agent not found' });

    await docRef.delete();
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[agents] delete failed', err);
    return res.status(500).json({ error: 'Failed to delete agent' });
  }
});

export default router;
