import express from 'express';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import topicContextYojRouter from './context/topicContextYoj.js';
import collapseIndexerRouter from './context/collapseIndexer.js';
import { getUserIdFromReq, projectScopedCollectionPath } from './utils.js';

const db = getFirestore();
const router = express.Router();

// Reuse the existing TopicContextYoj router under /context
// This exposes: POST /api/context/topicContextYoj/run
router.use('/', topicContextYojRouter);

// Expose collapse indexer and group state endpoints under /context
// - POST /api/context/collapse/indexer/run
// - POST /api/context/collapse/state/set
router.use('/', collapseIndexerRouter);

// POST /api/context/sessions/list
// Lists session documents (default collection: "convo.sessions") between start/end bounds.
// Body params:
//   - start: number (required, seconds since epoch)
//   - end: number (required, seconds since epoch)
//   - order: 'asc' | 'desc' (optional, default 'desc')
//   - limit: number (optional)
//   - collection: string (optional, defaults to 'convo.sessions')
//   - field: string (optional, defaults to 'update_time')
//   - fieldType: string (optional, 'timestamp' to treat bounds as seconds and coerce to Firestore Timestamp)
router.post('/sessions/list', async (req, res) => {
  try {
    const userId = await getUserIdFromReq(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing or invalid user token' });

    const {
      start,
      end,
      order = 'desc',
      limit,
      collection = 'convo.sessions',
      field = 'update_time',
      fieldType,
    } = req.body || {};

    if (start === undefined || end === undefined) {
      return res.status(400).json({ error: 'Missing required fields: start and end' });
    }

    const scoped = projectScopedCollectionPath(userId, req.projectId, collection);
    const ref = db.collection(scoped);

    const coerce = (v) => {
      if (fieldType === 'timestamp') {
        const n = typeof v === 'string' ? parseInt(v, 10) : v;
        const secs = Number.isFinite(n) ? Number(n) : 0;
        return Timestamp.fromMillis(secs * 1000);
      }
      return v;
    };

    const startVal = coerce(start);
    const endVal = coerce(end);

    let q = ref
      .where(field, '>', startVal)
      .where(field, '<=', endVal)
      .orderBy(field, order === 'asc' ? 'asc' : 'desc');

    if (limit && Number.isFinite(Number(limit))) {
      q = q.limit(parseInt(limit, 10));
    }

    const snapshot = await q.get();

    const documents = await Promise.all(
      snapshot.docs.map(async (doc) => {
        // Optionally include subcollections, mirroring jobs/firebase/list
        const subcollections = await doc.ref.listCollections();
        const subcollectionNames = subcollections.map((s) => s.id);
        return {
          id: doc.id,
          data: doc.data(),
          subcollections: subcollectionNames,
        };
      })
    );

    return res.status(200).json({ documents });
  } catch (err) {
    console.error('Error in /api/context/sessions/list:', err);
    return res.status(500).json({ error: 'Failed to list sessions: ' + (err?.message || String(err)) });
  }
});

export default router;
