import { getFirestore } from 'firebase-admin/firestore';
import { userScopedCollectionPath } from '../userAuth.js';

const db = getFirestore();

export function has(v) { return v !== undefined && v !== null; }

export function asBool(v, d = false) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true','1','yes','y','on'].includes(s)) return true;
    if (['false','0','no','n','off'].includes(s)) return false;
  }
  if (typeof v === 'number') return v !== 0;
  return d;
}

export function projectsCol(userId) {
  return db.collection(userScopedCollectionPath(userId, 'projects'));
}

export function projectDoc(userId, id) {
  return db.doc(userScopedCollectionPath(userId, `projects/${id}`));
}

export function integrationsCol(userId, projectId) {
  return projectDoc(userId, projectId).collection('integrations');
}

export function normalizeGitRemote(input) {
  if (!input) return '';
  let r = String(input).trim();
  // Strip protocol prefixes if present
  r = r.replace(/^git@/i, '')
       .replace(/^https?:\/\//i, '')
       .replace(/^ssh:\/\//i, '')
       .replace(/^git:\/\//i, '');
  // Common .git suffix kept as-is (example shows .git)
  return r;
}

export function projectIdMiddleware(req, res, next) {
  const projectId = req.header('x-project-id');

  if (!projectId) {
    return res.status(400).json({ error: 'Missing x-project-id header' });
  }

  req.projectId = projectId;
  next();
}
