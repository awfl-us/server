import { FieldPath } from 'firebase-admin/firestore';
import {
  applyPatch, assertStorage, fail, objectValue, partsOf,
  validatePath, validateQuery, StorageError,
} from '../document/contract.js';

// Provider metadata is internal to this adapter and never appears in data.
// Existing Firestore documents without metadata remain readable and are
// assigned revision 1 until they are first modified through the adapter.
const META = '__awflStorageMeta';
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const clone = value => structuredClone(value);
function checked(value) {
  const data = objectValue(value);
  if (own(data, META)) return fail('INVALID_DATA', `reserved document field: ${META}`);
  return data;
}
function asError(error) {
  if (error instanceof StorageError) return error;
  const code = String(error?.code ?? '').toLowerCase();
  const mapped = {
    '6': 'ALREADY_EXISTS', 'already-exists': 'ALREADY_EXISTS',
    '5': 'NOT_FOUND', 'not-found': 'NOT_FOUND',
    '3': 'INVALID_DATA', 'invalid-argument': 'INVALID_DATA',
    '9': 'FAILED_PRECONDITION', 'failed-precondition': 'FAILED_PRECONDITION',
    '10': 'ABORTED', 'aborted': 'ABORTED',
    '14': 'UNAVAILABLE', 'unavailable': 'UNAVAILABLE',
    '4': 'DEADLINE_EXCEEDED', 'deadline-exceeded': 'DEADLINE_EXCEEDED',
  }[code];
  return mapped ? new StorageError(mapped, error.message ?? mapped) : error;
}
function toDoc(snap) {
  if (!snap?.exists) return null;
  const raw = snap.data();
  const { [META]: metadata, ...data } = raw;
  const revision = metadata?.revision ?? 1;
  if (!Number.isSafeInteger(revision) || revision < 1) {
    return fail('INVALID_DATA', 'invalid document revision');
  }
  return {
    id: snap.id, path: snap.ref.path, data: objectValue(JSON.parse(JSON.stringify(data))), revision,
    createdAt: snap.createTime?.toDate().toISOString() ?? null,
    updatedAt: snap.updateTime?.toDate().toISOString() ?? null,
  };
}
function docRef(db, path) { return db.doc(validatePath(path)); }
async function firestoreQuery(db, spec) {
  const q = validateQuery(spec);
  let result = q.collection ? db.collection(q.collection) : db.collectionGroup(q.collectionGroup);
  for (const filter of q.where) {
    // FieldPath.documentId() is not a JSON data field.
    const field = filter.field === '__name__' ? FieldPath.documentId() : filter.field;
    result = result.where(field, filter.op, filter.value);
  }
  const nameOrder = q.orderBy.field === '__name__';
  const order = nameOrder ? FieldPath.documentId() : q.orderBy.field;
  result = result.orderBy(order, q.orderBy.direction);
  if (!nameOrder) result = result.orderBy(FieldPath.documentId(), q.orderBy.direction);
  if (q.startAfter !== undefined || q.endBefore !== undefined) {
    const cursor = async x => {
      validatePath(x);
      if (q.collection) {
        const p = partsOf(x);
        if (p.collectionPath !== q.collection)
          return fail('INVALID_QUERY', 'cursor belongs to another collection');
      }
      if (nameOrder) return q.collection ? partsOf(x).documentId : x;
      const snapshot = await db.doc(x).get();
      if (!snapshot.exists) return fail('INVALID_QUERY', 'cursor document not found');
      return snapshot;
    };
    if (q.startAfter !== undefined) result = result.startAfter(await cursor(q.startAfter));
    if (q.endBefore !== undefined) result = result.endBefore(await cursor(q.endBefore));
  }
  return { query: result.limit(q.limit), unlimited: result, spec: q };
}
function metadata(revision) { return { [META]: { revision } }; }
function payload(value, revision) { return { ...checked(value), ...metadata(revision) }; }

/**
 * Firestore implementation of the provider-neutral document Storage surface.
 * Firebase Admin/Auth remains independent of this adapter.
 *
 * JSON-only compatibility is intentional; Firestore Timestamp/GeoPoint/
 * DocumentReference/bytes codecs must be designed before bulk data migration.
 *
 * Unlike PostgreSQL's durable change log, Firestore onSnapshot alone cannot
 * replay an arbitrary missed interval. afterCursor explicitly fails closed.
 */
export class FirestoreStorage {
  constructor({ db, ownDb = false } = {}) {
    if (!db?.doc || !db?.collection || !db?.collectionGroup || !db?.runTransaction) {
      throw new TypeError('FirestoreStorage requires a Firestore database');
    }
    this.db = db;
    this.ownDb = ownDb;
    this.watchers = new Set();
    this.closed = false;
    assertStorage(this);
  }
  async get(path) {
    try { return toDoc(await docRef(this.db, path).get()); }
    catch (error) { throw asError(error); }
  }
  async create(path, value) {
    try { await docRef(this.db, path).create(payload(value, 1)); }
    catch (error) { throw asError(error); }
  }
  async put(path, value, options = {}) {
    return this.transaction(tx => tx.put(path, value, options));
  }
  async update(path, changes) {
    return this.transaction(tx => tx.update(path, changes));
  }
  async delete(path) {
    try { await docRef(this.db, path).delete(); }
    catch (error) { throw asError(error); }
  }
  async query(spec) {
    try {
      const { query } = await firestoreQuery(this.db, spec);
      return (await query.get()).docs.map(toDoc);
    } catch (error) { throw asError(error); }
  }
  async count(spec) {
    try {
      const { unlimited } = await firestoreQuery(this.db, spec);
      return (await unlimited.count().get()).data().count;
    } catch (error) { throw asError(error); }
  }
  async listCollections(documentPath) {
    try {
      return (await docRef(this.db, documentPath).listCollections())
        .map(collection => collection.id).sort();
    } catch (error) { throw asError(error); }
  }
  async batch(writes) {
    if (!Array.isArray(writes) || writes.length > 500) {
      return fail('INVALID_DATA', 'invalid batch size');
    }
    return this.transaction(async tx => {
      for (const item of writes) {
        if (!item || !['create', 'put', 'update', 'delete'].includes(item.op)) {
          return fail('INVALID_DATA', 'invalid batch operation');
        }
        if (item.op === 'delete') await tx.delete(item.path);
        else if (item.op === 'update') await tx.update(item.path, item.changes);
        else await tx[item.op](item.path, item.data, item.options);
      }
    });
  }
  async transaction(fn) {
    if (typeof fn !== 'function') throw new TypeError('transaction callback required');
    try {
      return await this.db.runTransaction(async firestoreTx => {
        const snapshots = new Map();
        const pending = new Map();
        // Delay all Firestore writes until the callback has returned.
        // This permits read/modify/write operations in any callback order.
        const load = async path => {
          validatePath(path);
          if (pending.has(path)) return pending.get(path).next;
          if (!snapshots.has(path)) {
            snapshots.set(path, toDoc(await firestoreTx.get(docRef(this.db, path))));
          }
          return snapshots.get(path);
        };
        const tx = Object.freeze({
          get: async path => clone(await load(path)),
          query: async spec => {
            if (pending.size) return fail('UNSUPPORTED', 'transactional queries after writes are not supported');
            return (await firestoreTx.get((await firestoreQuery(this.db, spec)).query)).docs.map(toDoc);
          },
          create: async (path, value) => {
            validatePath(path);
            if (pending.has(path)) return fail('INVALID_DATA', 'duplicate write to same document in transaction');
            const data = checked(value);
            pending.set(path, { op: 'create', next: { id: partsOf(path).documentId, path, data, revision: 1 } });
          },
          put: async (path, value, { merge = false } = {}) => {
            if (typeof merge !== 'boolean') return fail('INVALID_DATA', 'invalid merge option');
            const previous = await load(path);
            const data = checked(value);
            const nextData = merge && previous ? { ...previous.data, ...data } : data;
          checked(nextData);
            pending.set(path, {
              op: pending.get(path)?.op === 'create' ? 'create' : (previous ? 'set' : 'create'),
              next: { id: partsOf(path).documentId, path, data: nextData, revision: (previous?.revision ?? 0) + 1 },
            });
          },
          update: async (path, changes) => {
            const previous = await load(path);
            if (!previous) return fail('NOT_FOUND', 'document not found');
            const data = applyPatch(previous.data, changes);
            checked(data);
            pending.set(path, {
              op: pending.get(path)?.op === 'create' ? 'create' : 'set',
              next: { ...previous, data, revision: previous.revision + 1 },
            });
          },
          delete: async path => {
            validatePath(path);
            pending.set(path, { op: 'delete', next: null });
          },
        });
        const answer = await fn(tx);
        for (const [path, operation] of pending) {
          const ref = docRef(this.db, path);
          if (operation.op === 'delete') firestoreTx.delete(ref);
          else if (operation.op === 'create') firestoreTx.create(ref, payload(operation.next.data, operation.next.revision));
          else firestoreTx.set(ref, payload(operation.next.data, operation.next.revision));
        }
        return answer;
      });
    } catch (error) { throw asError(error); }
  }
  async subscribe(target, listener, { afterCursor } = {}) {
    if (this.closed) return fail('UNAVAILABLE', 'storage closed');
    if (typeof listener !== 'function') throw new TypeError('listener required');
    // Firestore's SDK does not expose a durable change cursor. Never pretend
    // that a reconnect from afterCursor can provide an exactly-once replay.
    if (afterCursor !== undefined) {
      return fail('UNSUPPORTED', 'Firestore subscriptions cannot replay from a durable cursor');
    }
    const path = typeof target === 'string' ? validatePath(target) : null;
    const source = path ? docRef(this.db, path) : (await firestoreQuery(this.db, target)).query;
    let initial = true;
    let previousExists = false;
    let sequence = 0;
    let settled = false;
    let ended = false;
    let unsubscribe;
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const watcher = () => { ended = true; unsubscribe?.(); this.watchers.delete(watcher); };
    this.watchers.add(watcher);
    let queue = Promise.resolve();
    const process = snapshot => {
      queue = queue.then(async () => {
        if (ended) return;
        const cursor = String(++sequence); // ephemeral, per subscription only
        const value = path ? toDoc(snapshot) : snapshot.docs.map(toDoc);
        if (initial) {
          initial = false;
          previousExists = path ? snapshot.exists : true;
          await listener({ type: 'snapshot', cursor, value });
          settled = true;
          resolveReady();
          return;
        }
        if (path) {
          const action = !snapshot.exists ? 'delete' : previousExists ? 'update' : 'create';
          previousExists = snapshot.exists;
          await listener({ type: 'change', cursor, path, action, value });
        } else {
          for (const change of snapshot.docChanges()) {
            await listener({
              type: 'change', cursor,
              path: change.doc.ref.path,
              action: change.type === 'added' ? 'create' :
                change.type === 'removed' ? 'delete' : 'update',
              value,
            });
          }
        }
      }).catch(async error => {
        if (!settled) { settled = true; rejectReady(asError(error)); watcher(); }
        else { try { await listener({ type: 'error', error: asError(error) }); } catch { /* subscriber isolation */ } }
      });
    };
    try {
      unsubscribe = source.onSnapshot(process, error => {
        if (!settled) { settled = true; rejectReady(asError(error)); watcher(); }
        else { void Promise.resolve().then(() => listener({ type: 'error', error: asError(error) })).catch(() => {}); }
      });
      await ready;
      return async () => watcher();
    } catch (error) {
      watcher();
      throw asError(error);
    }
  }
  async close() {
    this.closed = true;
    for (const unsubscribe of [...this.watchers]) unsubscribe();
    if (this.ownDb && typeof this.db.terminate === 'function') await this.db.terminate();
  }
}
