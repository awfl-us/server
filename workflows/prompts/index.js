import express from 'express';
import { getFirestore } from 'firebase-admin/firestore';
import { initializeApp, getApps } from 'firebase-admin/app';

// Ensure Firebase Admin is initialized once
if (!getApps().length) {
  try { initializeApp(); } catch (_) {}
}

const router = express.Router();
router.use(express.json());

// Parse query/body names filter supporting: names=[..] or names="a,b" or name=.. or only=..
function parseNamesFilter(q) {
  if (!q) return new Set();
  const vals = [];
  const add = (v) => { if (v !== undefined) vals.push(v); };
  add(q.names); add(q.name); add(q.only);

  const out = [];
  for (const v of vals) {
    if (!v) continue;
    if (Array.isArray(v)) { out.push(...v); continue; }
    if (typeof v === 'string') {
      const s = v.trim();
      if (!s) continue;
      if (s.startsWith('[') && s.endsWith(']')) {
        try { const arr = JSON.parse(s); if (Array.isArray(arr)) { out.push(...arr); continue; } } catch {}
      }
      out.push(...s.split(',').map(x => x.trim()).filter(Boolean));
    }
  }
  return new Set(out.map(String).map(s => s.trim()).filter(Boolean));
}

function asObjectOrNull(v) {
  if (v && typeof v === 'object') return v;
  try { if (typeof v === 'string' && v.trim().startsWith('{')) return JSON.parse(v); } catch {}
  return null;
}

// Strict normalization: only 'static' and 'workflow' kinds are supported.
function normalizePromptRaw(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : (typeof raw.id === 'string' ? raw.id.trim() : null);
  if (!name) return null;
  const description = typeof raw.description === 'string' ? raw.description : (typeof raw.desc === 'string' ? raw.desc : null);
  const kind = (raw.kind || raw.type || '').toLowerCase();

  if (kind === 'workflow') {
    const workflowName = typeof raw.workflowName === 'string' ? raw.workflowName.trim() : null;
    const params = asObjectOrNull(raw.params) || {};
    if (!workflowName) return null;
    return { name, description, kind: 'workflow', workflowName, params };
  }

  if (kind === 'static') {
    const content = typeof raw.content === 'string' ? raw.content : (typeof raw.text === 'string' ? raw.text : null);
    if (!content) return null;
    return { name, description, kind: 'static', content };
  }

  return null;
}

async function listFromFirestore(userId) {
  const out = [];
  try {
    const db = getFirestore();

    // User-scoped docs
    if (userId) {
      const userSnap = await db.collection(`users/${userId}/prompts/defs`).get();
      userSnap.forEach(d => {
        const norm = normalizePromptRaw({ id: d.id, ...d.data() });
        if (norm) out.push({ ...norm, id: d.id, source: 'user' });
      });
    }

    // Global docs (read-only)
    const globalSnap = await db.collection('prompts/defs/items').get().catch(() => ({ forEach: () => {} }));
    globalSnap.forEach(d => {
      const norm = normalizePromptRaw({ id: d.id, ...d.data() });
      if (norm) out.push({ ...norm, id: d.id, source: 'global' });
    });
  } catch (_) {
    // Firestore may be unavailable; ignore
  }
  return out;
}

function dedupeByName(preferred, fallbacks) {
  const map = new Map();
  for (const p of preferred || []) { if (p?.name) map.set(p.name, p); }
  for (const f of fallbacks || []) { if (f?.name && !map.has(f.name)) map.set(f.name, f); }
  return Array.from(map.values());
}

// Shape returned to clients
function toServiceItem(p) {
  if (!p) return null;
  const base = { name: p.name, description: p.description || null, kind: p.kind };
  if (p.kind === 'static') return { ...base, content: p.content };
  if (p.kind === 'workflow') return { ...base, workflowName: p.workflowName, params: p.params || {} };
  return null;
}

// GET /workflows/prompts/list -> { items: [ { name, description, kind, content? | workflowName?, params? } ] }
// Includes Firestore (user -> global) only; precedence user > global
// Optional query param: names (comma-separated, repeated, or JSON array)
router.get('/list', async (req, res) => {
  try {
    const userId = req.userId || null;
    const dbPrompts = await listFromFirestore(userId);

    // Merge already reflects both scopes, but dedupeByName safely preserves order
    const merged = dedupeByName(dbPrompts, []);
    const names = parseNamesFilter(req.query);
    const filtered = names.size > 0 ? merged.filter(p => names.has(p.name)) : merged;

    const items = filtered.map(toServiceItem).filter(Boolean);
    return res.json({ items });
  } catch (err) {
    console.error('[workflows/prompts] /list error:', err?.message || err);
    return res.status(500).json({ error: 'Failed to list prompts' });
  }
});

// POST /workflows/prompts/batch { names: string[] } -> { items: [...] }
router.post('/batch', async (req, res) => {
  try {
    const userId = req.userId || null;
    const names = new Set(Array.isArray(req.body?.names) ? req.body.names.map(String) : []);

    const dbPrompts = await listFromFirestore(userId);
    const merged = dedupeByName(dbPrompts, []);
    const filtered = names.size > 0 ? merged.filter(p => names.has(p.name)) : merged;
    const items = filtered.map(toServiceItem).filter(Boolean);
    return res.json({ items });
  } catch (err) {
    console.error('[workflows/prompts] /batch error:', err?.message || err);
    return res.status(500).json({ error: 'Failed to fetch prompt batch' });
  }
});

// Get a single prompt by id (tries user doc id, then user by name, then global by name)
router.get('/:id', async (req, res) => {
  try {
    const userId = req.userId || null;
    const { id } = req.params;
    const db = getFirestore();

    // Try user doc by id
    if (userId) {
      const docRef = db.doc(`users/${userId}/prompts/defs/${id}`);
      const snap = await docRef.get();
      if (snap.exists) {
        const norm = normalizePromptRaw({ id: snap.id, ...snap.data() });
        if (norm) return res.json({ prompt: toServiceItem(norm) });
      }
      // Try user by name
      const byNameSnap = await db.collection(`users/${userId}/prompts/defs`).where('name', '==', id).limit(1).get();
      if (!byNameSnap.empty) {
        const d = byNameSnap.docs[0];
        const norm = normalizePromptRaw({ id: d.id, ...d.data() });
        if (norm) return res.json({ prompt: toServiceItem(norm) });
      }
    }

    // Fall back to global Firestore by name
    const globalSnap = await db.collection('prompts/defs/items').where('name', '==', id).limit(1).get().catch(() => null);
    if (globalSnap && !globalSnap.empty) {
      const d = globalSnap.docs[0];
      const norm = normalizePromptRaw({ id: d.id, ...d.data() });
      if (norm) return res.json({ prompt: toServiceItem(norm) });
    }

    return res.status(404).json({ error: 'Prompt not found' });
  } catch (err) {
    console.error('[workflows/prompts] get error:', err?.message || err);
    return res.status(500).json({ error: 'Failed to get prompt' });
  }
});

function validatePromptBody(body) {
  const errors = [];
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const description = typeof body?.description === 'string' ? body.description : null;
  const kind = (body?.kind || body?.type || '').toLowerCase();
  if (!name) errors.push('name is required');
  if (kind !== 'static' && kind !== 'workflow') errors.push("kind must be 'static' or 'workflow'");
  let payload = null;
  if (kind === 'static') {
    const content = typeof body?.content === 'string' ? body.content : (typeof body?.text === 'string' ? body.text : null);
    if (!content) errors.push('content is required for static prompts');
    payload = { name, description, kind: 'static', content };
  } else if (kind === 'workflow') {
    const workflowName = typeof body?.workflowName === 'string' ? body.workflowName.trim() : null;
    const params = asObjectOrNull(body?.params) || {};
    if (!workflowName) errors.push('workflowName is required for workflow prompts');
    payload = { name, description, kind: 'workflow', workflowName, params };
  }
  return { errors, payload };
}

// Create a prompt (user-scoped). Body: { name, description?, kind: 'static'|'workflow', content? | workflowName?, params? }
router.post('/', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });

    const { errors, payload } = validatePromptBody(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const db = getFirestore();
    const colRef = db.collection(`users/${userId}/prompts/defs`);
    const docRef = colRef.doc();
    const now = Date.now();

    const data = { id: docRef.id, ...payload, created: now, updated: now, source: 'user' };
    await docRef.set(data, { merge: true });
    return res.status(201).json({ prompt: toServiceItem(data) });
  } catch (err) {
    console.error('[workflows/prompts] create error:', err?.message || err);
    return res.status(500).json({ error: 'Failed to create prompt' });
  }
});

// Update a prompt (user-scoped).
router.patch('/:id', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });

    const { id } = req.params;

    const db = getFirestore();
    const docRef = db.doc(`users/${userId}/prompts/defs/${id}`);
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Prompt not found' });

    // Merge updates, re-validate
    const before = snap.data();
    const merged = { ...before, ...req.body };
    const { errors, payload } = validatePromptBody(merged);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const updates = { ...payload, updated: Date.now() };
    await docRef.set(updates, { merge: true });
    const after = await docRef.get();
    const norm = normalizePromptRaw({ id: after.id, ...after.data() });
    return res.json({ prompt: toServiceItem(norm) });
  } catch (err) {
    console.error('[workflows/prompts] update error:', err?.message || err);
    return res.status(500).json({ error: 'Failed to update prompt' });
  }
});

// Delete a prompt (user-scoped).
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });

    const { id } = req.params;

    const db = getFirestore();
    const docRef = db.doc(`users/${userId}/prompts/defs/${id}`);
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Prompt not found' });

    await docRef.delete();
    return res.json({ ok: true });
  } catch (err) {
    console.error('[workflows/prompts] delete error:', err?.message || err);
    return res.status(500).json({ error: 'Failed to delete prompt' });
  }
});

export default router;
