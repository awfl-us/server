import { getFirestore } from 'firebase-admin/firestore';
import { projectScopedCollectionPath, userScopedCollectionPath } from '../utils.js';
import fs from 'node:fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Shared Firestore handle
export const db = getFirestore();

// Ensure req.userId is present (set by clientAuth upstream in workflows/index.js)
export function ensureUserAuth(req, res, next) {
  const userId = req?.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });
  next();
}

// Helpers
export function normalizeToolsInput(input) {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : [input];
  return arr
    .map(v => (typeof v === 'string' ? v.trim() : ''))
    .filter(v => !!v);
}

export function uniqueMerge(prev = [], add = []) {
  const set = new Set((prev || []).filter(v => typeof v === 'string'));
  for (const t of add) set.add(t);
  return Array.from(set);
}

export function removeFromList(prev = [], remove = []) {
  const removeSet = new Set(remove);
  return (prev || []).filter(v => !removeSet.has(v));
}

export const DEFAULT_TOOLS = [
  // 'READ_FILE',
  // 'UPDATE_FILE',
  // 'RUN_COMMAND',
  // 'CREATE_TASK',
  // 'UPDATE_TASK',
];

export function sessionMapDocPath(userId, projectId, sessionId) {
  return projectScopedCollectionPath(userId, projectId, `agentSessions/${sessionId}`);
}

// ESM-safe __dirname for this module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Shared loader for file-defined agents (from ./defs/*.json)
export async function loadFileDefinedAgents() {
  try {
    const defsDir = path.resolve(__dirname, './defs');
    const entries = await fs.readdir(defsDir, { withFileTypes: true });
    const files = entries.filter(e => e.isFile() && e.name.endsWith('.json'));
    const out = [];
    for (const f of files) {
      try {
        const full = path.join(defsDir, f.name);
        const raw = await fs.readFile(full, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') continue;
        const name = typeof parsed.name === 'string' ? parsed.name.trim() : null;
        const providedId = typeof parsed.id === 'string' ? parsed.id.trim() : null;
        const id = providedId || (name ? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') : null);
        if (!id || !name) continue;
        const description = typeof parsed.description === 'string' ? parsed.description : null;
        const workflowName = typeof parsed.workflowName === 'string' ? parsed.workflowName.trim() : null;
        const tools = Array.isArray(parsed.tools) ? parsed.tools.filter(t => typeof t === 'string') : undefined;
        const inputSchema = parsed.inputSchema && typeof parsed.inputSchema === 'object' ? parsed.inputSchema : undefined;
        out.push({ id, name, description, workflowName, tools, inputSchema, source: 'file' });
      } catch (_) {
        // skip malformed file
      }
    }
    return out;
  } catch (_) {
    return [];
  }
}

export async function getFileDefinedAgentById(id) {
  if (!id) return null;
  const list = await loadFileDefinedAgents();
  return list.find(a => a?.id === id) || null;
}

// Same persisted agent records and session mapping used by the web client.
// Centralize these operations so MCP does not add its own agent/session store.
export async function resolveAgent(userId, agentId, store = db) {
  const ref = store.doc(userScopedCollectionPath(userId, `agents/${agentId}`));
  const snapshot = await ref.get();
  return snapshot.exists ? snapshot.data() : getFileDefinedAgentById(agentId);
}

export async function createAgentRecord(userId, { name, workflowName, description = '', tools = DEFAULT_TOOLS }, store = db) {
  const ref = store.collection(userScopedCollectionPath(userId, 'agents')).doc();
  const now = Date.now();
  const agent = { id: ref.id, name: name.trim(), description, workflowName: workflowName.trim(),
    tools, created: now, updated: now };
  await ref.set(agent, { merge: true });
  return agent;
}

export async function linkAgentSession(userId, projectId, sessionId, agentId, store = db) {
  const agent = await resolveAgent(userId, agentId, store);
  if (!agent) return null;
  const ref = store.doc(sessionMapDocPath(userId, projectId, sessionId));
  const now = Date.now();
  await ref.set({ sessionId, agentId, updated: now, created: now }, { merge: true });
  return { sessionId, agentId };
}

export { userScopedCollectionPath };
