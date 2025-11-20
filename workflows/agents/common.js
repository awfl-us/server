import { getFirestore } from 'firebase-admin/firestore';
import { projectScopedCollectionPath, userScopedCollectionPath } from '../utils.js';

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
  'READ_FILE',
  'UPDATE_FILE',
  'RUN_COMMAND',
  'CREATE_TASK',
  'UPDATE_TASK',
];

export function sessionMapDocPath(userId, projectId, sessionId) {
  return projectScopedCollectionPath(userId, projectId, `agentSessions/${sessionId}`);
}

export { userScopedCollectionPath };
