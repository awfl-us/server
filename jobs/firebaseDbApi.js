// Legacy /firebase HTTP API backed by the provider-neutral document store.
// Keep the wire contract intact while removing Firebase SDK usage from Jobs.
import express from 'express';
import { getUserIdFromReq, projectScopedCollectionPath } from './userAuth.js';
import { getDocumentStorage, readDocuments } from '../storage/service.js';

const intLimit = (value, fallback = 100) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > 50000) return fallback;
  return n;
};
const seconds = value => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number.isFinite(Number(value)) ? Number(value) : Date.parse(value) / 1000;
  if (value && typeof value === 'object') {
    if (Number.isFinite(value.seconds)) return value.seconds;
    if (Number.isFinite(value._seconds)) return value._seconds;
  }
  return 0;
};
const field = (data, path) => path.split('.').reduce((obj, name) => obj?.[name], data);
const compare = (a, b) => a === b ? 0 : a < b ? -1 : 1;
const docId = (collection, id) => `${collection}/${String(id)}`;
const isDuplicate = error => error?.code === 'ALREADY_EXISTS' || error?.code === 6 ||
  error?.code === 'already-exists' || /already exists/i.test(String(error?.message));

export function createFirebaseDbRouter({ getStorage = getDocumentStorage } = {}) {
  const router = express.Router();
  const storage = () => getStorage();
  const scope = (req, name) => projectScopedCollectionPath(req._resolvedUserId, req.projectId, name);
  const resolveUserId = async req => {
    // Works with existing Jobs IAM user injection; preserve legacy trusted hints.
    const hinted = req?.body?.userId || req?.query?.userId || req?.headers?.['x-user-id'] || req?.userId;
    return hinted ? String(hinted) : await getUserIdFromReq(req);
  };
  router.use(async (req, res, next) => {
    try {
      req._resolvedUserId = await resolveUserId(req);
      if (!req._resolvedUserId) return res.status(401).json({ error: 'Unauthorized: missing or invalid user' });
      next();
    } catch (error) { next(error); }
  });

  router.post('/create', async (req, res) => {
    const { collection, id, contents } = req.body || {};
    if (!collection || !id) return res.status(400).json({ error: 'Missing required fields: collection or id' });
    try {
      await (await storage()).create(docId(scope(req, collection), id), contents ?? {});
      return res.status(200).json({ id: String(id) });
    } catch (error) {
      if (isDuplicate(error)) return res.status(409).json({ error: 'Document already exists' });
      console.error('Error creating document:', error);
      return res.status(500).json({ error: 'Failed to create document: ' + error.message });
    }
  });

  router.post('/read', async (req, res) => {
    const { collection, id } = req.body || {};
    if (!collection || !id) return res.status(400).json({ error: 'Missing required fields: collection or id' });
    try {
      const store = await storage(), path = docId(scope(req, collection), id);
      const doc = await store.get(path);
      if (!doc) return res.status(404).json({ error: 'Document not found' });
      return res.status(200).json({ ...doc.data, subcollections: await store.listCollections(path) });
    } catch (error) {
      console.error('Error reading document:', error);
      return res.status(500).json({ error: 'Failed to read document: ' + error.message });
    }
  });

  router.post('/update', async (req, res) => {
    const { collection, id, contents } = req.body || {};
    if (!collection || !id || !contents) return res.status(400).json({ error: 'Missing required fields: collection, id, or contents' });
    try {
      // Legacy callers use /update as a merge-upsert (including absent session parents).
      await (await storage()).put(docId(scope(req, collection), id), contents,{merge:true});
      return res.status(200).json({ message: 'Document updated successfully' });
    } catch (error) {
      console.error('Error updating document:', error);
      return res.status(500).json({ error: 'Failed to update document: ' + error.message });
    }
  });

  router.post('/delete', async (req, res) => {
    const { collection, id } = req.body || {};
    if (!collection || !id) return res.status(400).json({ error: 'Missing required fields: collection or id' });
    try {
      await (await storage()).delete(docId(scope(req, collection), id));
      return res.status(200).json({ message: 'Document deleted successfully' });
    } catch (error) {
      console.error('Error deleting document:', error);
      return res.status(500).json({ error: 'Failed to delete document: ' + error.message });
    }
  });

  router.post('/locks/acquire', async (req, res) => {
    const { collection, id, ttlSeconds = 300, owner } = req.body || {};
    if (!collection || !id || !owner) return res.status(400).json({ error: 'Missing required fields: collection, id, or owner' });
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) {
      return res.status(400).json({ error: 'ttlSeconds must be an integer from 1 to 3600' });
    }
    try {
      const store = await storage(), path = docId(scope(req, collection), id);
      const now = Math.floor(Date.now() / 1000);
      const result = await store.transaction(async tx => {
        const doc = await tx.get(path), prior = doc?.data || {};
        const created = seconds(prior.created);
        const previousTtl = Number.isSafeInteger(prior.ttlSeconds) && prior.ttlSeconds > 0
          ? prior.ttlSeconds : ttlSeconds;
        if (!doc || created + previousTtl <= now) {
          // A new owner supplies a new lease duration; never inherit the
          // duration of the previous, expired owner.
          const value = { created: now, owner: String(owner), ttlSeconds };
          if (doc) await tx.put(path, value); else await tx.create(path, value);
          return { acquired: true, owner, created: now };
        }
        return { acquired: false, owner: prior.owner || '', created };
      });
      return res.status(result.acquired ? 200 : 409).json(result);
    } catch (error) {
      console.error('Error acquiring lock:', error);
      return res.status(500).json({ error: 'Failed to acquire lock: ' + error.message });
    }
  });

  router.post('/locks/release', async (req, res) => {
    const { collection, id, owner } = req.body || {};
    if (!collection || !id || !owner) return res.status(400).json({ error: 'Missing required fields: collection, id, or owner' });
    try {
      const store = await storage(), path = docId(scope(req, collection), id);
      const released = await store.transaction(async tx => {
        const doc = await tx.get(path);
        if (doc?.data?.owner !== String(owner)) return false;
        await tx.delete(path);
        return true;
      });
      return res.status(200).json({ released });
    } catch (error) {
      console.error('Error releasing lock:', error);
      return res.status(500).json({ error: 'Failed to release lock: ' + error.message });
    }
  });

  const enrich = async (store, doc) => ({ id: doc.id, data: doc.data,
    subcollections: await store.listCollections(doc.path) });

  router.post('/listAt', async (req, res) => {
    const { collection, at, before, after } = req.body || {};
    if (!collection) return res.status(400).json({ error: 'Missing required field: collection' });
    try {
      const store = await storage(), scoped = scope(req, collection), docs = [];
      const filter = at === undefined || at === null ? [] : [{ field: 'create_time', op: '<=', value: at }];
      if (before) {
        const result = await store.query({ collection: scoped, where: filter,
          orderBy: { field: 'create_time', direction: 'desc' }, limit: Math.min(intLimit(before),1000) });
        docs.push(...result.reverse());
      }
      if (after) {
        const result = await store.query({ collection: scoped,
          where: at === undefined || at === null ? [] : [{ field: 'create_time', op: '>', value: at }],
          orderBy: { field: 'create_time', direction: 'asc' }, limit: Math.min(intLimit(after),1000) });
        docs.push(...result);
      }
      return res.status(200).json({ documents: await Promise.all(docs.map(d => enrich(store,d))) });
    } catch (error) {
      console.error('Error listing documents:', error);
      return res.status(500).json({ error: 'Failed to list documents:', details: error.message });
    }
  });

  router.post('/list', async (req, res) => {
    const { collection, start, end, field: fieldName = 'create_time', order = 'asc', fieldType } = req.body || {};
    if (!collection || start === undefined || end === undefined) return res.status(400).json({ error: 'Missing required fields: collection, start, or end' });
    try {
      const store = await storage(), scoped = scope(req, collection);
      // Time stamp migration may contain mixed numeric/Firestore timestamp data.
      // Filter in a type-independent way until all legacy documents are backfilled.
      const timestamp = fieldType === 'timestamp';
      const docs = await readDocuments(store, timestamp ? { collection: scoped } : {
        collection: scoped, where: [
          { field: fieldName, op: '>', value: start },
          { field: fieldName, op: '<=', value: end },
        ],
      });
      const valid = timestamp ? docs.filter(doc => {
        const value = seconds(field(doc.data, fieldName));
        return value > Number(start) && value <= Number(end);
      }) : docs;
      valid.sort((a, b) => {
        const av = timestamp ? seconds(field(a.data,fieldName)) : field(a.data,fieldName);
        const bv = timestamp ? seconds(field(b.data,fieldName)) : field(b.data,fieldName);
        return (order === 'desc' ? -1 : 1) * (compare(av,bv) || compare(a.path,b.path));
      });
      return res.status(200).json({ documents: await Promise.all(valid.map(d=>enrich(store,d))) });
    } catch (error) {
      console.error('Error listing between timestamps:', error);
      return res.status(500).json({ error: 'Failed to list documents between timestamps: ' + error.message });
    }
  });

  router.post('/segmentsForSession', async (req, res) => {
    const { collection, windowSeconds = 1200, overlapSeconds = 240 } = req.body || {};
    if (!collection) return res.status(400).json({ error: 'Missing required field: collection' });
    const stride = Number(windowSeconds) - Number(overlapSeconds);
    if (stride <= 0) return res.status(400).json({ error: 'overlapSeconds must be smaller than windowSeconds' });
    try {
      const store = await storage();
      const docs = await readDocuments(store, { collection: scope(req, collection) });
      const stamps = docs.map(d => seconds(field(d.data,'create_time'))).filter(n=>n>0).sort((a,b)=>a-b);
      if (!stamps.length) return res.status(200).json({ segments: [] });
      const segments = [];
      let index = 0;
      for (let start = stamps[0]; start <= stamps.at(-1); start += stride) {
        const end = start + Number(windowSeconds);
        while (index < stamps.length && stamps[index] < start) index++;
        if (index < stamps.length && stamps[index] <= end) segments.push({collection,end,windowSeconds});
      }
      return res.status(200).json({segments});
    } catch (error) {
      console.error('Error computing populated segments:', error);
      return res.status(500).json({ error: 'Failed to compute segments: ' + error.message });
    }
  });
  return router;
}
export default createFirebaseDbRouter();
