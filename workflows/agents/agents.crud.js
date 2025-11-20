import express from 'express';
import { db, userScopedCollectionPath } from './common.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const router = express.Router();

// Resolve default agent input schema from workflows/types/agent_input.json (ESM-safe)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultSchemaPath = path.resolve(__dirname, '../types/agent_input.json');
let defaultAgentInputSchema = undefined;
function loadDefaultAgentInputSchema() {
  if (defaultAgentInputSchema !== undefined) return defaultAgentInputSchema;
  try {
    const raw = readFileSync(defaultSchemaPath, 'utf-8');
    defaultAgentInputSchema = JSON.parse(raw);
  } catch (err) {
    console.error('[agents] failed to load default agent input schema', { defaultSchemaPath, err });
    defaultAgentInputSchema = null;
  }
  return defaultAgentInputSchema;
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

    // Only set tools if provided; otherwise leave undefined so list endpoint can return defaults
    if (Array.isArray(tools) && tools.length) data.tools = tools;

    // Optional: attach explicit inputSchema if provided
    if (inputSchema && typeof inputSchema === 'object') data.inputSchema = inputSchema;

    await docRef.set(data, { merge: true });
    return res.status(201).json({ agent: data });
  } catch (err) {
    console.error('[agents] create failed', err);
    return res.status(500).json({ error: 'Failed to create agent' });
  }
});

// List agents (optionally limit/order)
router.get('/', async (req, res) => {
  try {
    const userId = req.userId;
    const { limit = 50, order = 'desc' } = req.query || {};

    const q = db
      .collection(userScopedCollectionPath(userId, 'agents'))
      .orderBy('created', order === 'asc' ? 'asc' : 'desc')
      .limit(Math.min(Number(limit) || 50, 200));

    const snap = await q.get();
    const baseSchema = loadDefaultAgentInputSchema();
    const agents = snap.docs.map((d) => {
      const a = d.data();
      if (a && a.inputSchema) return a;
      return baseSchema ? { ...a, inputSchema: baseSchema } : a;
    });
    return res.status(200).json({ agents });
  } catch (err) {
    console.error('[agents] list failed', err);
    return res.status(500).json({ error: 'Failed to list agents' });
  }
});

// Get a single agent
router.get('/:id', async (req, res) => {
  try {
    const userId = req.userId;
    const { id } = req.params;
    const docRef = db.doc(userScopedCollectionPath(userId, `agents/${id}`));
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Agent not found' });
    const agent = snap.data();
    const baseSchema = loadDefaultAgentInputSchema();
    const enriched = agent && agent.inputSchema ? agent : (baseSchema ? { ...agent, inputSchema: baseSchema } : agent);
    return res.status(200).json({ agent: enriched });
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

    const baseSchema = loadDefaultAgentInputSchema();
    const agent = after.data();
    const enriched = agent && agent.inputSchema ? agent : (baseSchema ? { ...agent, inputSchema: baseSchema } : agent);

    return res.status(200).json({ agent: enriched });
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
