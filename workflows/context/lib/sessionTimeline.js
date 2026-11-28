import { createHash } from 'node:crypto';
import { validatePath } from '../../../storage/document/contract.js';

const hash = value => createHash('sha256').update(value).digest('base64url');
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 30;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const validSegment = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && value !== '.' && value !== '..' && !/[\/\u0000-\u001f]/.test(value);
const validTime = value => typeof value === 'number' && Number.isFinite(value);

export class TimelineError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = message => { throw new TimelineError(400, message); };

function collectionFor(userId, projectId, sessionId) {
  if (![userId, projectId, sessionId].every(validSegment)) bad('Invalid timeline scope');
  return validatePath(`users/${userId}/projects/${projectId}/convo.sessions/${sessionId}/messages`, 'collection');
}

function encodeCursor(scope, doc) {
  return Buffer.from(JSON.stringify([1, scope, doc.id, doc.data.create_time])).toString('base64url');
}

async function decodeCursor(storage, collection, scope, encoded) {
  if (typeof encoded !== 'string' || encoded.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(encoded)) bad('Invalid timeline cursor');
  let parts;
  try { parts = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { bad('Invalid timeline cursor'); }
  if (!Array.isArray(parts) || parts.length !== 4 || parts[0] !== 1 || parts[1] !== scope || !validSegment(parts[2]) || !validTime(parts[3])) bad('Invalid timeline cursor');
  const path = `${collection}/${parts[2]}`;
  const doc = await storage.get(path);
  if (!doc || doc.data?.create_time !== parts[3]) throw new TimelineError(409, 'Timeline cursor is stale; reload the latest page');
  return path;
}

function toRow(doc) {
  const { data } = doc;
  const stored = data.value;
  // Preserve malformed/unknown message payloads as inspectable rows; do not
  // guess a role or filter them out. The wrapper timestamp is the ordering key.
  const message = stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : { content: stored ?? null };
  message.docId = doc.id;
  if (message.cost === undefined && data.cost !== undefined) message.cost = data.cost;
  if (message.execId === undefined && data.execId !== undefined) message.execId = data.execId;
  const kind = ['user', 'assistant', 'tool', 'system'].includes(message.role) ? message.role : 'unknown';
  return { id: hash(doc.path), createTime: data.create_time, kind, message };
}

// One bounded query, no prompt filters/promotion and no time-window eviction.
export async function readSessionTimeline(storage, { userId, projectId, sessionId, limit = DEFAULT_LIMIT, before, after } = {}) {
  const collection = collectionFor(userId, projectId, sessionId);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) bad(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  if (before !== undefined && after !== undefined) bad('Specify either before or after, not both');
  const scope = hash(collection);
  const cursor = before !== undefined ? before : after;
  const forward = after !== undefined;
  const path = cursor === undefined ? undefined : await decodeCursor(storage, collection, scope, cursor);
  // Restrict to numeric nonnegative timestamps; all normal message writes use
  // epoch seconds. No server clock dependency or lower age bound.
  const docs = await storage.query({collection, where:[{field:'create_time',op:'>=',value:0},{field:'create_time',op:'<=',value:Number.MAX_SAFE_INTEGER}], orderBy:{field:'create_time',direction:forward?'asc':'desc'}, limit:limit+1, ...(path && { startAfter:path })});
  const selected = [];
  let bytes = 0;
  for (const doc of docs.slice(0,limit)) {
    if (!validTime(doc.data?.create_time)) throw new Error('Invalid stored timeline timestamp');
    const row = toRow(doc);
    const size = Buffer.byteLength(JSON.stringify(row));
    if (selected.length && bytes + size > MAX_PAGE_BYTES) break;
    selected.push({doc,row}); bytes += size;
  }
  const hasMore = docs.length > selected.length;
  if (!forward) selected.reverse();
  return {
    version: 1,
    rows: selected.map(x => x.row),
    oldestCursor: selected.length ? encodeCursor(scope,selected[0].doc) : null,
    newestCursor: selected.length ? encodeCursor(scope,selected.at(-1).doc) : null,
    hasMore,
  };
}
