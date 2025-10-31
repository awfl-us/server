import express from 'express';
import { getFirestore } from 'firebase-admin/firestore';
import { initializeApp, getApps } from 'firebase-admin/app';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Ensure Firebase Admin is initialized once (reuse global app if already inited)
if (!getApps().length) {
  try { initializeApp(); } catch (_) {}
}

const router = express.Router();
router.use(express.json());

// Helpers
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Local defs dir under workflows/tools/defs
const DEFS_DIR = path.join(__dirname, 'defs');

function stripMetaKeys(obj) {
  const clone = { ...obj };
  delete clone.name;
  delete clone.description;
  delete clone.workflowName;
  delete clone.id;
  delete clone.toolName;
  delete clone.type; // when top-level file used OpenAI-style with type
  delete clone.function; // do not duplicate
  return clone;
}

function normalizeToolDef(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const fn = raw && typeof raw.function === 'object' ? raw.function : null;
  const name = raw.name || raw.id || raw.toolName || (fn && fn.name);
  if (!name) return null;
  const description = raw.description || raw.desc || (fn && fn.description) || '';
  const workflowName = raw.workflowName || 'tools-CliTools';

  // Prefer explicit defs/spec if provided; support OpenAI-style { type:'function', function:{...} }
  let defs = raw.defs || raw.spec || (raw.type === 'function' || raw.function ? { type: 'function', function: raw.function } : null);
  if (!defs) {
    const candidate = stripMetaKeys(raw);
    defs = Object.keys(candidate).length ? candidate : raw;
  }

  return { name, description, workflowName, defs };
}

async function listFromFirestore(userId) {
  try {
    const db = getFirestore();

    const userDocs = [];
    if (userId) {
      const userScoped = await db.collection(`users/${userId}/tools/defs`).get();
      userScoped.forEach(d => userDocs.push({ id: d.id, ...d.data() }));
    }

    const globalDocs = [];
    const globalScoped = await db.collection('tools/defs/items').get().catch(() => ({ forEach: () => {} }));
    globalScoped.forEach(d => globalDocs.push({ id: d.id, ...d.data() }));

    const combined = [...userDocs, ...globalDocs];
    return combined.map(normalizeToolDef).filter(Boolean);
  } catch (_err) {
    // Firestore may be unavailable in some environments; return empty so we still include files
    return [];
  }
}

async function collectJsonFiles(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          stack.push(full);
        } else if (e.isFile() && e.name.endsWith('.json')) {
          files.push(full);
        }
      }
    } catch (_e) {
      // skip unreadable dirs
    }
  }
  return files;
}

async function listFromFiles() {
  const results = [];
  try {
    const files = await collectJsonFiles(DEFS_DIR);
    for (const f of files) {
      try {
        const content = await fs.readFile(f, 'utf-8');
        const json = JSON.parse(content);
        const arr = Array.isArray(json) ? json : [json];
        for (const item of arr) {
          const norm = normalizeToolDef(item);
          if (norm) results.push(norm);
        }
      } catch (e) {
        console.error(`[workflows/tools] Failed reading ${f}:`, e?.message || e);
      }
    }
  } catch (_e) {
    // defs dir might not exist; return empty
  }
  return results;
}

function parseNamesFilter(q) {
  if (!q) return new Set();
  const vals = [];
  const add = (v) => { if (v !== undefined) vals.push(v); };
  add(q.names); add(q.name); add(q.only);

  const out = [];
  for (const v of vals) {
    if (!v) continue;
    if (Array.isArray(v)) {
      out.push(...v);
      continue;
    }
    if (typeof v === 'string') {
      const s = v.trim();
      if (!s) continue;
      if (s.startsWith('[') && s.endsWith(']')) {
        try {
          const arr = JSON.parse(s);
          if (Array.isArray(arr)) { out.push(...arr); continue; }
        } catch {}
      }
      out.push(...s.split(',').map(x => x.trim()).filter(Boolean));
    }
  }
  return new Set(out.map(String).map(s => s.trim()).filter(Boolean));
}

function normalizeParameters(params) {
  // Coerce to { type: 'object', properties: {...}, required: [] }
  const out = { type: 'object', properties: {}, required: [] };
  if (!params || typeof params !== 'object') return out;

  const props = (params.properties && typeof params.properties === 'object') ? params.properties : params;
  out.properties = {};
  for (const [k, v] of Object.entries(props || {})) {
    if (!v || typeof v !== 'object') {
      out.properties[k] = { type: String(v || 'string'), enum: [] };
      continue;
    }
    const t = typeof v.type === 'string' ? v.type : 'string';
    const e = Array.isArray(v.enum) ? v.enum : [];
    out.properties[k] = { type: t, enum: e };
  }

  out.required = Array.isArray(params.required) ? params.required.filter(Boolean) : [];
  return out;
}

function toLlmTool(t) {
  if (!t) return null;
  // If already OpenAI-style
  if (t.defs && (t.defs.type === 'function' || t.defs.function)) {
    const fn = t.defs.function || {};
    const name = fn.name || t.name;
    const description = fn.description || t.defs.description || t.description || '';
    const parameters = normalizeParameters(fn.parameters || t.defs.parameters || {});
    return { type: 'function', function: { name, description, parameters } };
  }

  // Otherwise, synthesize from defs or defaults
  const description = (t.defs && t.defs.description) || t.description || '';
  const parameters = normalizeParameters(t.defs && (t.defs.parameters || t.defs));
  return { type: 'function', function: { name: t.name, description, parameters } };
}

function toServiceItem(t) {
  const tool = toLlmTool(t);
  if (!tool) return null;
  return { ...tool, workflowName: t.workflowName || 'tools-CliTools' };
}

// GET /workflows/tools/list -> returns an envelope: { items: [ { type:'function', function:{ name, description, parameters }, workflowName } ] }
// Includes both Firestore (user -> global) and local defs, with precedence user > global > files on duplicates
// Optional query param: names (comma-separated, repeated, or JSON array) to filter the returned tool names
router.get('/list', async (req, res) => {
  try {
    const userId = req.userId || null; // provided by clientAuth middleware

    const [dbTools, fileTools] = await Promise.all([
      listFromFirestore(userId),
      listFromFiles(),
    ]);

    const seen = new Set();
    const tools = [];
    const pushUnique = (arr) => {
      for (const t of arr) {
        if (!t?.name) continue;
        if (seen.has(t.name)) continue;
        seen.add(t.name);
        tools.push(t);
      }
    };

    // Precedence: user/global DB first, then files
    pushUnique(dbTools || []);
    pushUnique(fileTools || []);

    const names = parseNamesFilter(req.query);
    const filtered = names.size > 0 ? tools.filter(t => names.has(t.name)) : tools;

    const items = filtered.map(toServiceItem).filter(Boolean);
    return res.json({ items });
  } catch (err) {
    console.error('[workflows/tools] /list error:', err?.message || err);
    return res.status(500).json({ error: 'Failed to list tools' });
  }
});

export default router;
