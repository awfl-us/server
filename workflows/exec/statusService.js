import { projectScopedCollectionPath } from '../utils.js';
import { COLLECTIONS, toSeconds } from './shared.js';

// Shared by the existing status endpoint and the Agents MCP.
export async function latestSessionExecutions({ db, userId, projectId, sessionId,
  limit = 5, includeMetadata = false }) {
  const n = Math.max(1, Math.min(50, Number(limit) || 5));
  const regs = projectScopedCollectionPath(userId, projectId, COLLECTIONS.regs);
  const statuses = projectScopedCollectionPath(userId, projectId, COLLECTIONS.statuses);
  const window = Math.min(50, Math.max(n * 5, n));
  const snapshot = await db.collection(regs).where('sessionId', '==', sessionId)
    .orderBy('created', 'desc').limit(window).get();
  if (snapshot.empty) {
    return includeMetadata ? { items: [], hasRegistrations: false } : [];
  }
  const found = await Promise.all(snapshot.docs.map(async doc => {
    const data = doc.data() || {};
    if (!data.execId) return null;
    const value = { execId: String(data.execId), created: toSeconds(data.created) };
    const status = await db.collection(statuses).doc(value.execId).get();
    return status.exists ? { ...value, ...status.data() } : value;
  }));
  const items = found.filter(row => typeof row?.status === 'string' && row.status.trim()).slice(0, n);
  return includeMetadata ? { items, hasRegistrations: true } : items;
}
