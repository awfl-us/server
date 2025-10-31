import express from 'express';
import { getFirestore } from 'firebase-admin/firestore';
import { getUserIdFromReq, projectScopedCollectionPath } from '../utils.js';
import { COLLECTIONS, toSeconds } from './shared.js';

const router = express.Router();

// POST /workflows/exec/tree
// Body: { userId?: string, sessionId: string, latestOnly?: boolean | 'true' | 'false' }
// Note: userId may be supplied by trusted internal callers; otherwise inferred via getUserIdFromReq
// Returns workflow execution trees for the given sessionId under the authenticated user scope.
// - Default: returns all trees (forest) for the session
// - When latestOnly === true (or 'true'): returns only the tree rooted at the latest exec for that session
router.post('/tree', async (req, res) => {
  try {
    const userId = await getUserIdFromReq(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing or invalid user token' });

    const { sessionId, latestOnly } = req.body || {};
    const latestOnlyFlag = latestOnly === true || latestOnly === 'true';

    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'Missing required field: sessionId' });
    }

    const db = getFirestore();

    const regsCollection = projectScopedCollectionPath(userId, req.projectId, COLLECTIONS.regs);
    const linksCollection = projectScopedCollectionPath(userId, req.projectId, COLLECTIONS.links);

    // Fetch all exec registrations for this session
    const regsSnap = await db
      .collection(regsCollection)
      .where('sessionId', '==', sessionId)
      .orderBy('created', 'desc')
      .get();

    if (regsSnap.empty) {
      return res.status(404).json({ error: 'No executions found for session' });
    }

    const createdByExec = new Map();
    const execIds = new Set();

    for (const doc of regsSnap.docs) {
      const data = doc.data() || {};
      const execId = String(data.execId || '');
      const created = toSeconds(data.created);
      if (execId) {
        execIds.add(execId);
        createdByExec.set(execId, created);
      }
    }

    // Fetch all links for this session
    const linksSnap = await db
      .collection(linksCollection)
      .where('sessionId', '==', sessionId)
      .get();

    const childrenByParent = new Map(); // parentExecId -> Array<{ id: string, created: number }>
    const hasParent = new Set();

    for (const doc of linksSnap.docs) {
      const ld = doc.data() || {};
      const parent = ld.callingExec ? String(ld.callingExec) : '';
      const child = ld.triggeredExec ? String(ld.triggeredExec) : '';
      if (parent && child) {
        if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
        const childCreated = toSeconds(ld.created);
        childrenByParent.get(parent).push({ id: child, created: childCreated });
        hasParent.add(child);
      }
    }

    const visited = new Set();

    const buildNode = async (execId) => {
      // Guard cycles and unknowns
      if (!execId || visited.has(execId)) {
        return { execId, created: createdByExec.get(execId) || 0, children: [] };
      }
      visited.add(execId);

      const children = [];
      const nextItems = childrenByParent.get(execId) || [];
      // Deterministic child ordering by link.created ascending
      nextItems.sort((a, b) => (a.created || 0) - (b.created || 0));
      for (const { id: cid } of nextItems) {
        children.push(await buildNode(cid));
      }

      return {
        execId,
        created: createdByExec.get(execId) || 0,
        children,
      };
    };

    // If only the latest exec's tree is requested, build and return just that
    if (latestOnlyFlag) {
      const latestExecId = String(regsSnap.docs[0]?.data()?.execId || '');
      if (!latestExecId) {
        return res.status(404).json({ error: 'No latest execution id found for session' });
      }
      const tree = await buildNode(latestExecId);
      return res.status(200).json({ sessionId, trees: [tree] });
    }

    // Otherwise, build the full forest
    // Roots are execs that never appear as a child
    let roots = [...execIds].filter((id) => !hasParent.has(id));

    // Fallback: if a cycle made all nodes children, pick the newest as a root
    if (roots.length === 0) {
      const newest = regsSnap.docs[0]?.data()?.execId;
      if (newest) roots = [String(newest)];
    }

    const trees = [];
    for (const r of roots) {
      trees.push(await buildNode(r));
    }

    // Sort trees by root created desc for convenience
    trees.sort((a, b) => (b.created || 0) - (a.created || 0));

    return res.status(200).json({ sessionId, trees });
  } catch (err) {
    console.error('Error building exec trees:', err);
    return res.status(500).json({ error: 'Failed to build exec trees', details: err?.message || String(err) });
  }
});

export default router;
