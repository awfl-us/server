import express from 'express';
import { getFirestore } from 'firebase-admin/firestore';
import { userScopedCollectionPath } from './userAuth.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const router = express.Router();
const db = getFirestore();

// Helpers
function has(v) { return v !== undefined && v !== null; }
function asObjectOrNull(v) {
  if (v && typeof v === 'object') return v;
  try {
    if (typeof v === 'string' && v.trim().startsWith('{')) return JSON.parse(v);
  } catch (_) {}
  return null;
}

async function loadBuiltinDefs() {
  try {
    const dirUrl = new URL('./defs/', import.meta.url);
    const dirPath = fileURLToPath(dirUrl);
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const jsonFiles = entries.filter(e => e.isFile() && e.name.endsWith('.json'));
    const out = [];
    for (const f of jsonFiles) {
      try {
        const full = path.join(dirPath, f.name);
        const raw = await fs.readFile(full, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') continue;
        const name = typeof parsed.name === 'string' ? parsed.name.trim() : null;
        if (!name) continue;
        out.push({
          id: name, // expose built-ins by name as stable id
          name,
          description: typeof parsed.description === 'string' ? parsed.description : null,
          inputSchema: parsed.inputSchema && typeof parsed.inputSchema === 'object' ? parsed.inputSchema : null,
          outputSchema: parsed.outputSchema && typeof parsed.outputSchema === 'object' ? parsed.outputSchema : null,
          source: 'builtin',
        });
      } catch (_) {
        // Skip malformed file
      }
    }
    return out;
  } catch (_) {
    return [];
  }
}

function dedupeByName(preferred, fallbacks) {
  const map = new Map();
  for (const d of preferred) {
    if (!d?.name) continue;
    map.set(d.name, d);
  }
  for (const d of fallbacks) {
    if (!d?.name) continue;
    if (!map.has(d.name)) map.set(d.name, d);
  }
  return Array.from(map.values());
}

// Create a workflow definition
// Body: { name: string, description?: string, inputSchema?: object|string, outputSchema?: object|string }
router.post('/', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });

    const { name, description, inputSchema, outputSchema } = req.body || {};
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name is required' });
    }

    const colRef = db.collection(userScopedCollectionPath(userId, 'workflowDefinitions'));

    // Optional: prevent creating a user doc that conflicts with a builtin by the same name
    const builtins = await loadBuiltinDefs();
    if (builtins.some(b => b.name === name.trim())) {
      return res.status(409).json({ error: 'A builtin workflow with this name already exists' });
    }

    const docRef = colRef.doc();
    const now = Date.now();

    const data = {
      id: docRef.id,
      name: name.trim(),
      description: typeof description === 'string' ? description : null,
      inputSchema: asObjectOrNull(inputSchema),
      outputSchema: asObjectOrNull(outputSchema),
      created: now,
      updated: now,
      source: 'user',
    };

    await docRef.set(data, { merge: true });
    return res.status(201).json({ definition: data });
  } catch (err) {
    console.error('[definitions] create failed', err);
    return res.status(500).json({ error: 'Failed to create workflow definition' });
  }
});

// List workflow definitions (optionally limit/order). Always includes builtins, deduped by name.
router.get('/', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });

    const { limit = 50, order = 'desc' } = req.query || {};

    const builtins = await loadBuiltinDefs();

    const q = db
      .collection(userScopedCollectionPath(userId, 'workflowDefinitions'))
      .orderBy('created', order === 'asc' ? 'asc' : 'desc')
      .limit(Math.min(Number(limit) || 50, 200));

    const snap = await q.get();
    const userDefs = snap.docs.map(d => d.data());

    // Deduplicate by name; user definitions override builtins
    const definitions = dedupeByName(userDefs, builtins);

    return res.status(200).json({ definitions });
  } catch (err) {
    console.error('[definitions] list failed', err);
    return res.status(500).json({ error: 'Failed to list workflow definitions' });
  }
});

// Get a single workflow definition (by Firestore id or by builtin name)
router.get('/:id', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });

    const { id } = req.params;

    // Try Firestore by doc id first
    const docRef = db.doc(userScopedCollectionPath(userId, `workflowDefinitions/${id}`));
    const snap = await docRef.get();
    if (snap.exists) {
      return res.status(200).json({ definition: snap.data() });
    }

    // Fallback: find builtin by name or by base filename (id)
    const builtins = await loadBuiltinDefs();
    const byName = builtins.find(b => b.id === id || b.name === id);
    if (byName) return res.status(200).json({ definition: byName });

    return res.status(404).json({ error: 'Workflow definition not found' });
  } catch (err) {
    console.error('[definitions] get failed', err);
    return res.status(500).json({ error: 'Failed to get workflow definition' });
  }
});

// Update a workflow definition (name/description/inputSchema/outputSchema)
router.patch('/:id', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });

    const { id } = req.params;

    // Disallow updates to builtin definitions
    const builtins = await loadBuiltinDefs();
    if (builtins.some(b => b.id === id || b.name === id)) {
      return res.status(400).json({ error: 'Builtin workflow definitions cannot be modified' });
    }

    const { name, description, inputSchema, outputSchema } = req.body || {};

    const docRef = db.doc(userScopedCollectionPath(userId, `workflowDefinitions/${id}`));
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Workflow definition not found' });

    const updates = { updated: Date.now() };
    if (has(name)) updates.name = String(name).trim();
    if (has(description)) updates.description = typeof description === 'string' ? description : null;
    if (has(inputSchema)) updates.inputSchema = asObjectOrNull(inputSchema);
    if (has(outputSchema)) updates.outputSchema = asObjectOrNull(outputSchema);

    await docRef.set(updates, { merge: true });
    const after = await docRef.get();
    return res.status(200).json({ definition: after.data() });
  } catch (err) {
    console.error('[definitions] update failed', err);
    return res.status(500).json({ error: 'Failed to update workflow definition' });
  }
});

// Delete a workflow definition
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });

    const { id } = req.params;

    // Disallow deletes of builtin definitions
    const builtins = await loadBuiltinDefs();
    if (builtins.some(b => b.id === id || b.name === id)) {
      return res.status(400).json({ error: 'Builtin workflow definitions cannot be deleted' });
    }

    const docRef = db.doc(userScopedCollectionPath(userId, `workflowDefinitions/${id}`));
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Workflow definition not found' });

    await docRef.delete();
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[definitions] delete failed', err);
    return res.status(500).json({ error: 'Failed to delete workflow definition' });
  }
});

export default router;
