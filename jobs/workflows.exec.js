import express from 'express';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getUserIdFromReq, projectScopedCollectionPath } from './userAuth.js';

const router = express.Router();

const COLLECTIONS = {
  links: 'workflowExecLinks',
  regs: 'workflowExecsBySession',
  statuses: 'workflowExecStatus',
};

// POST /workflows/exec/links/register
// Body: { userId?: string, callingExecId: string, triggeredExecId: string, sessionId: string, created?: number }
// Note: userId may be supplied by trusted internal callers; otherwise inferred via getUserIdFromReq
// Upserts a link document at id `${callingExecId}:${triggeredExecId}` with fields { callingExec, triggeredExec, sessionId, created }
router.post('/links/register', async (req, res) => {
  try {
    const userId = req?.body?.userId || await getUserIdFromReq(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing or invalid user token' });

    const { callingExecId, triggeredExecId, sessionId, created } = req.body || {};
    if (!callingExecId || !triggeredExecId || !sessionId) {
      return res.status(400).json({ error: 'callingExecId, triggeredExecId, and sessionId are required' });
    }
    const db = getFirestore();
    const linksCollection = projectScopedCollectionPath(userId, req.projectId, COLLECTIONS.links);
    const id = `${String(callingExecId)}:${String(triggeredExecId)}`;
    const ref = db.collection(linksCollection).doc(id);

    const payload = {
      callingExec: String(callingExecId),
      triggeredExec: String(triggeredExecId),
      sessionId: String(sessionId),
      created: typeof created === 'number' ? created : Math.floor(Date.now() / 1000),
    };

    try {
      await ref.create(payload);
      return res.status(200).json({ id, data: payload, status: 'created' });
    } catch (err) {
      // On already exists, update (idempotent upsert)
      const code = err?.code || err?.status || err?.response?.status;
      if (code === 6 || code === 'ALREADY_EXISTS' || /already exists/i.test(String(err?.message))) {
        await ref.set(payload, { merge: true });
        return res.status(200).json({ id, data: payload, status: 'updated' });
      }
      throw err;
    }
  } catch (err) {
    console.error('Error registering exec link:', err);
    return res.status(500).json({ error: 'Failed to register exec link', details: err?.message || String(err) });
  }
});

// GET /workflows/exec/links/by-calling/:callingExecId
router.get('/links/by-calling/:callingExecId', async (req, res) => {
  try {
    const userId = await getUserIdFromReq(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { callingExecId } = req.params;
    const db = getFirestore();
    const linksCollection = projectScopedCollectionPath(userId, req.projectId, COLLECTIONS.links);

    const snap = await db
      .collection(linksCollection)
      .where('callingExec', '==', String(callingExecId))
      .get();

    const items = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    return res.status(200).json(items);
  } catch (err) {
    console.error('Error listing links by caller:', err);
    return res.status(500).json({ error: 'Failed to list links by caller', details: err?.message || String(err) });
  }
});

// GET /workflows/exec/links/by-triggered/:triggeredExecId
router.get('/links/by-triggered/:triggeredExecId', async (req, res) => {
  try {
    const userId = await getUserIdFromReq(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { triggeredExecId } = req.params;
    const db = getFirestore();
    const linksCollection = projectScopedCollectionPath(userId, req.projectId, COLLECTIONS.links);

    const snap = await db
      .collection(linksCollection)
      .where('triggeredExec', '==', String(triggeredExecId))
      .get();

    if (snap.empty) return res.status(404).json({ error: 'Not found' });

    let doc = snap.docs[0];
    if (snap.size > 1) {
      // Pick latest by created desc
      doc = snap.docs.sort((a, b) => (b.get('created') || 0) - (a.get('created') || 0))[0];
    }

    return res.status(200).json({ id: doc.id, data: doc.data() });
  } catch (err) {
    console.error('Error get link by triggered:', err);
    return res.status(500).json({ error: 'Failed to get link by triggered', details: err?.message || String(err) });
  }
});

// POST /workflows/exec/status/update
// Body: { userId?: string, execId: string, status?: string, result?: any, error?: any, ended?: boolean, updated?: number, workflow?: string }
// Idempotently upserts a status document at id `${execId}` with fields { status, result, error, ended, updated, created, workflow }
router.post('/status/update', async (req, res) => {
  try {
    const userId = req?.body?.userId || await getUserIdFromReq(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing or invalid user token' });

    const { execId, status, result, error, ended, updated, workflow } = req.body || {};
    if (!execId || typeof execId !== 'string') {
      return res.status(400).json({ error: 'Missing required field: execId' });
    }

    // Require at least one meaningful field to update
    if (
      status == null &&
      result == null &&
      error == null &&
      ended == null &&
      updated == null &&
      workflow == null
    ) {
      return res.status(400).json({ error: 'Nothing to update: provide one of status, result, error, ended, updated, workflow' });
    }

    const db = getFirestore();
    const statusesCollection = projectScopedCollectionPath(userId, req.projectId, COLLECTIONS.statuses);
    const regsCollection = projectScopedCollectionPath(userId, req.projectId, COLLECTIONS.regs);
    const ref = db.collection(statusesCollection).doc(String(execId));

    const nowSec = Math.floor(Date.now() / 1000);

    // Fetch existing to preserve created timestamp
    const existing = await ref.get();
    const created = existing.exists ? (existing.get('created') || nowSec) : nowSec;

    const payload = {
      ...(status != null ? { status: String(status) } : {}),
      ...(result !== undefined ? { result } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(ended !== undefined ? { ended: Boolean(ended) } : {}),
      ...(workflow != null ? { workflow: String(workflow) } : {}),
      updated: typeof updated === 'number' ? updated : nowSec,
      created,
    };

    await ref.set(payload, { merge: true });

    // Also mirror status fields onto the exec registration record (if present)
    try {
      const regSnap = await db
        .collection(regsCollection)
        .where('execId', '==', String(execId))
        .limit(1)
        .get();
      if (!regSnap.empty) {
        const regRef = regSnap.docs[0].ref;
        const regUpdate = {
          ...(status != null ? { status: String(status) } : {}),
          ...(ended !== undefined ? { ended: Boolean(ended) } : {}),
          updated: typeof updated === 'number' ? updated : nowSec,
        };
        await regRef.set(regUpdate, { merge: true });
      }
    } catch (mirrorErr) {
      // Best-effort; don't fail the overall request
      console.warn('Warning: failed to mirror status onto registration record:', mirrorErr?.message || mirrorErr);
    }

    return res.status(200).json({ id: ref.id, data: payload, status: existing.exists ? 'updated' : 'created' });
  } catch (err) {
    console.error('Error updating exec status:', err);
    return res.status(500).json({ error: 'Failed to update exec status', details: err?.message || String(err) });
  }
});

// POST /workflows/exec/status
// Body: { userId?: string, sessionId: string, limit?: number }
// Returns the latest N exec registrations for a session, each with its current status (or UNKNOWN if not recorded)
router.post('/status', async (req, res) => {
  try {
    const userId = req?.body?.userId || await getUserIdFromReq(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { sessionId } = req.body || {};
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'Missing required field: sessionId' });
    }

    const limitRaw = req.body?.limit ?? req.query?.limit;
    let limit = Number(limitRaw);
    if (!Number.isFinite(limit) || limit <= 0) limit = 5;
    if (limit > 50) limit = 50; // defensive cap

    const db = getFirestore();
    const regsCollection = projectScopedCollectionPath(userId, req.projectId, COLLECTIONS.regs);
    const statusesCollection = projectScopedCollectionPath(userId, req.projectId, COLLECTIONS.statuses);

    const regsSnap = await db
      .collection(regsCollection)
      .where('sessionId', '==', String(sessionId))
      .orderBy('created', 'desc')
      .limit(limit)
      .get();

    if (regsSnap.empty) {
      return res.status(404).json({ error: 'No executions found for session' });
    }

    // Assemble exec list preserving order by created desc
    const items = [];
    for (const doc of regsSnap.docs) {
      const d = doc.data() || {};
      const execId = String(d.execId || '');
      const created = typeof d.created === 'number' ? d.created : (d.created instanceof Timestamp ? d.created.seconds : 0);
      if (!execId) continue;
      items.push({ execId, created });
    }

    // Fetch statuses in parallel (simple approach to preserve order)
    const results = await Promise.all(
      items.map(async (it) => {
        try {
          const snap = await db.collection(statusesCollection).doc(it.execId).get();
          if (!snap.exists) return { ...it, status: 'UNKNOWN' };
          const data = snap.data() || {};
          return { ...it, ...data };
        } catch (e) {
          return { ...it, status: 'UNKNOWN', error: `status-fetch-failed: ${e?.message || String(e)}` };
        }
      })
    );

    return res.status(200).json({ sessionId, limit, items: results });
  } catch (err) {
    console.error('Error getting latest exec statuses (POST):', err);
    return res.status(500).json({ error: 'Failed to get latest exec statuses', details: err?.message || String(err) });
  }
});

export default router;
