import express from 'express';
import { getFirestore } from 'firebase-admin/firestore';
import { projectScopedCollectionPath } from './userAuth.js';
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

async function loadBuiltinTypes() {
  try {
    const dirUrl = new URL('./types/', import.meta.url);
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

        // Support both wrapped { name, description, schema } and plain schema files
        const schemaObj = parsed && typeof parsed.schema === 'object' ? parsed.schema : parsed;
        const base = path.basename(f.name, '.json');

        const name = (typeof parsed.name === 'string' && parsed.name.trim())
          ? parsed.name.trim()
          : (typeof schemaObj.title === 'string' && schemaObj.title.trim())
            ? schemaObj.title.trim()
            : (typeof parsed.title === 'string' && parsed.title.trim())
              ? parsed.title.trim()
              : base;

        const description = (typeof parsed.description === 'string')
          ? parsed.description
          : (typeof schemaObj.description === 'string')
            ? schemaObj.description
            : null;

        out.push({
          id: name, // expose built-ins by name as stable id
          name,
          description,
          schema: schemaObj,
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

// Create a type
// Body: { name: string, description?: string, schema?: object|string }
router.post('/', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });

    const { name, description, schema } = req.body || {};
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name is required' });
    }

    const colRef = db.collection(projectScopedCollectionPath(userId, req.projectId, 'workflowTypes'));

    // Prevent creating a user doc that conflicts with a builtin by the same name
    const builtins = await loadBuiltinTypes();
    if (builtins.some(b => b.name === name.trim())) {
      return res.status(409).json({ error: 'A builtin type with this name already exists' });
    }

    const docRef = colRef.doc();
    const now = Date.now();

    const data = {
      id: docRef.id,
      name: name.trim(),
      description: typeof description === 'string' ? description : null,
      schema: asObjectOrNull(schema),
      created: now,
      updated: now,
      source: 'user',
    };

    await docRef.set(data, { merge: true });
    return res.status(201).json({ type: data });
  } catch (err) {
    console.error('[types] create failed', err);
    return res.status(500).json({ error: 'Failed to create type' });
  }
});

// List types (optionally limit/order). Always includes builtins, deduped by name.
router.get('/', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });

    const { limit = 100, order = 'desc' } = req.query || {};

    const builtins = await loadBuiltinTypes();

    const q = db
      .collection(projectScopedCollectionPath(userId, req.projectId, 'workflowTypes'))
      .orderBy('created', order === 'asc' ? 'asc' : 'desc')
      .limit(Math.min(Number(limit) || 100, 500));

    const snap = await q.get();
    const userTypes = snap.docs.map(d => d.data());

    // Deduplicate by name; user types override builtins (but creation of conflicting names is blocked)
    const types = dedupeByName(userTypes, builtins);

    return res.status(200).json({ types });
  } catch (err) {
    console.error('[types] list failed', err);
    return res.status(500).json({ error: 'Failed to list types' });
  }
});

// Get a single type (by Firestore id or by builtin name)
router.get('/:id', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });

    const { id } = req.params;

    // Try Firestore by doc id first
    const docRef = db.doc(projectScopedCollectionPath(userId, req.projectId, `workflowTypes/${id}`));
    const snap = await docRef.get();
    if (snap.exists) {
      return res.status(200).json({ type: snap.data() });
    }

    // Fallback: find builtin by name
    const builtins = await loadBuiltinTypes();
    const byName = builtins.find(b => b.id === id || b.name === id);
    if (byName) return res.status(200).json({ type: byName });

    return res.status(404).json({ error: 'Type not found' });
  } catch (err) {
    console.error('[types] get failed', err);
    return res.status(500).json({ error: 'Failed to get type' });
  }
});

// Update a type (name/description/schema)
router.patch('/:id', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });

    const { id } = req.params;

    // Disallow updates to builtin types
    const builtins = await loadBuiltinTypes();
    if (builtins.some(b => b.id === id || b.name === id)) {
      return res.status(400).json({ error: 'Builtin types cannot be modified' });
    }

    const { name, description, schema } = req.body || {};

    const docRef = db.doc(projectScopedCollectionPath(userId, req.projectId, `workflowTypes/${id}`));
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Type not found' });

    const updates = { updated: Date.now() };
    if (has(name)) updates.name = String(name).trim();
    if (has(description)) updates.description = typeof description === 'string' ? description : null;
    if (has(schema)) updates.schema = asObjectOrNull(schema);

    await docRef.set(updates, { merge: true });
    const after = await docRef.get();
    return res.status(200).json({ type: after.data() });
  } catch (err) {
    console.error('[types] update failed', err);
    return res.status(500).json({ error: 'Failed to update type' });
  }
});

// Delete a type
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });

    const { id } = req.params;

    // Disallow deletes of builtin types
    const builtins = await loadBuiltinTypes();
    if (builtins.some(b => b.id === id || b.name === id)) {
      return res.status(400).json({ error: 'Builtin types cannot be deleted' });
    }

    const docRef = db.doc(projectScopedCollectionPath(userId, req.projectId, `workflowTypes/${id}`));
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Type not found' });

    await docRef.delete();
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[types] delete failed', err);
    return res.status(500).json({ error: 'Failed to delete type' });
  }
});

export default router;
