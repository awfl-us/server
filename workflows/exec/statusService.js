import { projectScopedCollectionPath } from '../utils.js';
import { COLLECTIONS, toSeconds } from './shared.js';

// Shared by the existing status endpoint and the Agents MCP.
export async function latestSessionExecutions({ db, userId, projectId, sessionId,
  limit = 5, includeMetadata = false }) {
  const n = Math.max(1, Math.min(50, Number(limit) || 5));
  const regs = projectScopedCollectionPath(userId, projectId, COLLECTIONS.regs);
  const statuses = projectScopedCollectionPath(userId, projectId, COLLECTIONS.statuses);
  // Native child workflows register under the session but generally do not
  // write a user-turn lifecycle status. A fixed n*5 registration window can
  // therefore hide a previously completed foreground execution as soon as
  // more than five child registrations appear. Page *registrations* until n
  // actual status records have been found (or the session is exhausted).
  const pageSize = 50;
  const maxScanned = 10000;
  let cursor, scanned = 0, hasRegistrations = false;
  const items = [];
  while (scanned < maxScanned && items.length < n) {
    let query = db.collection(regs).where('sessionId', '==', sessionId)
      .orderBy('created', 'desc').limit(Math.min(pageSize, maxScanned - scanned));
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    if (snapshot.empty) break;
    hasRegistrations = true;
    scanned += snapshot.docs.length;
    const found = await Promise.all(snapshot.docs.map(async doc => {
      const data = doc.data() || {};
      if (!data.execId) return null;
      const value = { execId: String(data.execId), created: toSeconds(data.created) };
      const status = await db.collection(statuses).doc(value.execId).get();
      return status.exists ? { ...value, ...status.data() } : null;
    }));
    items.push(...found.filter(row => typeof row?.status === 'string' && row.status.trim()));
    if (snapshot.docs.length < pageSize) break;
    cursor = snapshot.docs.at(-1);
  }
  // Return an explicit failure rather than a false `unknown` if pathological
  // sessions exceed the safety cap before a status is found.
  if (scanned === maxScanned && items.length < n) {
    // An exactly-full session is valid. Reject only if another registration
    // actually exists beyond the scan cap.
    const extra = await db.collection(regs).where('sessionId', '==', sessionId)
      .orderBy('created', 'desc').startAfter(cursor).limit(1).get();
    if (!extra.empty) throw new Error('Session status scan exceeded registration limit');
  }
  const result = items.slice(0, n);
  return includeMetadata ? { items: result, hasRegistrations } : result;
}
