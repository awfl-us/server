// Add Firebase Admin SDK for CRUD operations
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import express from 'express';
import { getUserIdFromReq, projectScopedCollectionPath } from './userAuth.js';

// Initialize Firebase Admin SDK
if (!getApps().length) {
  initializeApp();
}

const db = getFirestore();

const router = express.Router();

// Prefer explicit userId (body/query/header/req.userId) then fall back to token-based extraction
async function resolveUserId(req) {
  console.log("REq body: ", req.body);
  const hinted = req?.body?.userId || req?.query?.userId || req?.headers?.['x-user-id'] || req?.userId;
  if (hinted) return String(hinted);
  return await getUserIdFromReq(req);
}

// --------------------------------------------------
// Helper: project create_time only (saves bandwidth)
// --------------------------------------------------
const projectCreateTime = (collectionRef) =>
  // Firestore projection: select() returns only specified fields
  collectionRef.select('create_time').orderBy('create_time', 'asc');

// --------------------------------------------------
// Firebase CRUD operations
// --------------------------------------------------

// Create a document (atomic create; fails if the document already exists)
router.post('/create', async (req, res) => {
  try {
    const { collection, id, contents } = req.body;
    if (!collection || !id) {
      return res.status(400).json({ error: 'Missing required fields: collection or id' });
    }

    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing or invalid user' });

    const scoped = projectScopedCollectionPath(userId, req.projectId, collection);
    const docRef = db.collection(scoped).doc(String(id));
    await docRef.create(contents ?? {});
    res.status(200).json({ id: String(id) });
  } catch (error) {
    // Firestore throws an ALREADY_EXISTS error if the document exists
    const message = (error && error.message) ? String(error.message) : '';
    const code = (error && (error.code !== undefined)) ? error.code : undefined;
    const alreadyExists = message.toLowerCase().includes('already exists') || code === 6 || code === 'already-exists';
    if (alreadyExists) {
      return res.status(409).json({ error: 'Document already exists' });
    }
    console.error('Error creating document:', error);
    res.status(500).json({ error: 'Failed to create document: ' + message });
  }
});

// Read a document
router.post('/read', async (req, res) => {
  try {
    const { collection, id } = req.body;
    if (!collection || !id) {
      return res.status(400).json({ error: 'Missing required fields: collection or id' });
    }

    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing or invalid user' });

    const scoped = projectScopedCollectionPath(userId, req.projectId, collection);
    const docRef = db.collection(scoped).doc(id);
    const doc = await docRef.get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Get the subcollections
    const subcollections = await docRef.listCollections();
    const subcollectionNames = subcollections.map((subcol) => subcol.id);

    const response = {
      ...doc.data(),
      subcollections: subcollectionNames,
    };
    res.status(200).json(response);
  } catch (error) {
    console.error('Error reading document:', error);
    res.status(500).json({ error: 'Failed to read document: ' + error });
  }
});

// Update a document
router.post('/update', async (req, res) => {
  try {
    const { collection, id, contents } = req.body;
    if (!collection || !id || !contents) {
      return res.status(400).json({ error: 'Missing required fields: collection, id, or contents' });
    }

    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing or invalid user' });

    const scoped = projectScopedCollectionPath(userId, req.projectId, collection);
    await db.collection(scoped).doc(id).update(contents, { merge: true });
    res.status(200).json({ message: 'Document updated successfully' });
  } catch (error) {
    console.error('Error updating document:', error);
    res.status(500).json({ error: 'Failed to update document: ' + error + ' \n Request: ' + JSON.stringify(req.body) });
  }
});

// Delete a document
router.post('/delete', async (req, res) => {
  try {
    const { collection, id } = req.body;
    if (!collection || !id) {
      return res.status(400).json({ error: 'Missing required fields: collection or id' });
    }

    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing or invalid user' });

    const scoped = projectScopedCollectionPath(userId, req.projectId, collection);
    await db.collection(scoped).doc(id).delete();
    res.status(200).json({ message: 'Document deleted successfully' });
  } catch (error) {
    console.error('Error deleting document:', error);
    res.status(500).json({ error: 'Failed to delete document: ' + error });
  }
});

// --------------------------------------------------
// Locks (with simple TTL)
// --------------------------------------------------
router.post('/locks/acquire', async (req, res) => {
  try {
    const { collection, id, ttlSeconds = 300, owner } = req.body;
    if (!collection || !id || !owner) {
      return res.status(400).json({ error: 'Missing required fields: collection, id, or owner' });
    }

    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing or invalid user' });

    const scoped = projectScopedCollectionPath(userId, req.projectId, collection);
    const docRef = db.collection(scoped).doc(String(id));
    const nowSec = Math.floor(Date.now() / 1000);

    const result = await db.runTransaction(async (t) => {
      const snap = await t.get(docRef);
      if (!snap.exists) {
        t.create(docRef, { created: nowSec, owner, ttlSeconds });
        return { acquired: true, owner, created: nowSec };
      }
      const data = snap.data() || {};
      const createdRaw = data.created;
      const created = createdRaw instanceof Timestamp ? createdRaw.seconds : (typeof createdRaw === 'number' ? createdRaw : 0);
      const ttl = typeof data.ttlSeconds === 'number' ? data.ttlSeconds : parseInt(ttlSeconds, 10) || 300;
      const expired = created + ttl <= nowSec;
      if (expired) {
        t.set(docRef, { created: nowSec, owner, ttlSeconds: ttl }, { merge: false });
        return { acquired: true, owner, created: nowSec };
      }
      return { acquired: false, owner: data.owner || '', created };
    });

    if (result.acquired) {
      return res.status(200).json(result);
    }
    return res.status(409).json(result);
  } catch (error) {
    console.error('Error acquiring lock:', error);
    res.status(500).json({ error: 'Failed to acquire lock: ' + (error?.message || String(error)) });
  }
});

router.post('/locks/release', async (req, res) => {
  try {
    const { collection, id, owner } = req.body;
    if (!collection || !id || !owner) {
      return res.status(400).json({ error: 'Missing required fields: collection, id, or owner' });
    }

    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing or invalid user' });

    const scoped = projectScopedCollectionPath(userId, req.projectId, collection);
    const docRef = db.collection(scoped).doc(String(id));

    await db.runTransaction(async (t) => {
      const snap = await t.get(docRef);
      if (!snap.exists) return;
      const data = snap.data() || {};
      if (data.owner === owner) {
        t.delete(docRef);
      }
    });

    res.status(200).json({ released: true });
  } catch (error) {
    console.error('Error releasing lock:', error);
    res.status(500).json({ error: 'Failed to release lock: ' + (error?.message || String(error)) });
  }
});

// --------------------------------------------------
// Listing helpers
// --------------------------------------------------

// List documents in a collection around a pivot
router.post('/listAt', async (req, res) => {
  try {
    const { collection, at, before, after } = req.body;

    if (!collection) {
      return res.status(400).json({ error: 'Missing required field: collection' });
    }

    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing or invalid user' });

    const scoped = projectScopedCollectionPath(userId, req.projectId, collection);
    const collectionRef = db.collection(scoped);
    let query = collectionRef.orderBy('create_time', 'asc');

    const queries = [];

    if (at) {
      if (before) {
        queries.push(query.endAt(at).limitToLast(parseInt(before, 10)).get());
      }
      if (after) {
        queries.push(query.startAfter(at).limit(parseInt(after, 10)).get());
      }
    } else {
      if (before) {
        queries.push(query.limitToLast(parseInt(before, 10)).get());
      }
      if (after) {
        queries.push(query.limit(parseInt(after, 10)).get());
      }
    }

    const snapshots = await Promise.all(queries);
    const documents = [];

    for (const snapshot of snapshots) {
      for (const docSnapshot of snapshot.docs) {
        const docRef = docSnapshot.ref;
        const subcollections = await docRef.listCollections();
        const subcollectionNames = subcollections.map((subcol) => subcol.id);

        documents.push({
          id: docSnapshot.id,
          data: docSnapshot.exists ? docSnapshot.data() : {},
          subcollections: subcollectionNames,
        });
      }
    }

    res.status(200).json({ documents });
  } catch (error) {
    console.error('Error listing documents:', error);
    res.status(500).json({ error: 'Failed to list documents:', details: error.message });
  }
});

// List documents between timestamps
router.post('/list', async (req, res) => {
  try {
    const { collection, start, end, field = 'create_time', order = 'asc', fieldType } = req.body;
    if (!collection || start === undefined || end === undefined) {
      return res.status(400).json({ error: 'Missing required fields: collection, start, or end' });
    }

    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing or invalid user' });

    const scoped = projectScopedCollectionPath(userId, req.projectId, collection);
    let ref = db.collection(scoped);

    // Convert bounds if the underlying field is a Firestore Timestamp.
    const toBound = (v) => {
      if (fieldType === 'timestamp') {
        const n = typeof v === 'string' ? parseInt(v, 10) : v;
        const secs = Number.isFinite(n) ? Number(n) : 0;
        return Timestamp.fromMillis(secs * 1000);
      }
      return v;
    };

    const startVal = toBound(start);
    const endVal = toBound(end);

    const snapshot = await ref
      .where(field, '>', startVal)
      .where(field, '<=', endVal)
      .orderBy(field, order === 'desc' ? 'desc' : 'asc')
      .get();

    const documents = await Promise.all(
      snapshot.docs.map(async (doc) => {
        const docRef = doc.ref;
        const subcollections = await docRef.listCollections();
        const subcollectionNames = subcollections.map((sub) => sub.id);
        return {
          id: doc.id,
          data: doc.data(),
          subcollections: subcollectionNames,
        };
      })
    );

    res.status(200).json({ documents });
  } catch (error) {
    console.error('Error listing between timestamps:', error);
    res.status(500).json({ error: 'Failed to list documents between timestamps: ' + error.message });
  }
});

// --------------------------------------------------
// NEW: segmentsForSession — returns only populated segment windows
// --------------------------------------------------
router.post('/segmentsForSession', async (req, res) => {
  try {
    const { collection, windowSeconds = 1200, overlapSeconds = 240 } = req.body;

    if (!collection) {
      return res.status(400).json({ error: 'Missing required field: collection' });
    }

    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing or invalid user' });

    const scoped = projectScopedCollectionPath(userId, req.projectId, collection);

    const stride = windowSeconds - overlapSeconds;
    if (stride <= 0) {
      return res.status(400).json({ error: 'overlapSeconds must be smaller than windowSeconds' });
    }

    // Single-pass read of all timestamps (create_time) for the session
    const snapshot = await projectCreateTime(db.collection(scoped)).get();

    if (snapshot.empty) {
      return res.status(200).json({ segments: [] });
    }

    const timestamps = snapshot.docs
      .map((d) => {
        const ts = d.get('create_time');
        if (ts instanceof Timestamp) return ts.seconds;
        // Fallback: assume numeric (seconds)
        return typeof ts === 'number' ? ts : 0;
      })
      .filter((s) => s > 0);

    if (!timestamps.length) {
      return res.status(200).json({ segments: [] });
    }

    const firstTs = timestamps[0];
    const lastTs = timestamps[timestamps.length - 1];

    let windowStart = firstTs;
    let windowEnd = windowStart + windowSeconds;
    const segments = [];

    let idx = 0; // pointer into timestamps array
    const n = timestamps.length;

    while (windowStart <= lastTs) {
      // Advance idx to first timestamp >= windowStart
      while (idx < n && timestamps[idx] < windowStart) idx++;
      // Check if current idx is within window
      if (idx < n && timestamps[idx] <= windowEnd) {
        // Important: return the original unscoped collection for client compatibility.
        segments.push({ collection, end: windowEnd, windowSeconds });
      }
      windowStart += stride;
      windowEnd += stride;
    }

    res.status(200).json({ segments });
  } catch (error) {
    console.error('Error computing populated segments:', error);
    res.status(500).json({ error: 'Failed to compute segments: ' + error.message });
  }
});

// Export the router
export default router;
