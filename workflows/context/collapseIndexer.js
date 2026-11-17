// Collapse indexer HTTP job
// Builds per-session indexes for collapsed groups written by ContextCollapser
// Also exposes endpoints to manage per-group UI state (e.g., expanded true/false)
// POST /context/collapse/indexer/run (mounted under /api/context)
// POST /context/collapse/state/set

import express from 'express';
import { getDocumentStorage } from '../../storage/service.js';
import { getUserIdFromReq, projectScopedCollectionPath } from '../userAuth.js';

const router = express.Router();

const BATCH_WRITE_LIMIT = 400; // stay under Firestore RPC limits
const MAX_GROUPS_PER_MESSAGE = 200; // safeguard against oversized per-message docs

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function sanitizeGroupName(name) {
  if (!name) return '';
  const upper = String(name).trim().toUpperCase();
  // Replace invalid chars with underscore; collapse repeats; trim underscores
  return upper.replace(/[^A-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}

async function commitWritesInChunks(db,ops) {
  for(let i=0;i<ops.length;i+=BATCH_WRITE_LIMIT){
    const group=ops.slice(i,i+BATCH_WRITE_LIMIT);
    // messageToGroups is an accumulating map: Firestore set(merge:true)
    // merged nested keys; generic Storage.put merge is intentionally shallow.
    // Keep the merge atomic and preserve previously indexed groups.
    const deep=group.filter(op=>op.type==='deepMergeGroups');
    const writes=group.filter(op=>op.type!=='deepMergeGroups').map(op=>({
      op:op.type==='delete'?'delete':op.type==='update'?'update':'put',
      path:op.path,
      ...(op.type==='update'?{changes:op.data}:
        op.type==='delete'?{}:{data:op.data,options:op.options||{merge:true}}),
    }));
    if(writes.length)await db.batch(writes);
    for(const op of deep){
      await db.transaction(async tx=>{
        const current=await tx.get(op.path);
        const data={...(current?.data||{}),groups:{
          ...(current?.data?.groups||{}),...op.data.groups,
        }};
        await tx.put(op.path,data);
      });
    }
  }
}

async function indexCollapseGroups({ userId, projectId, sessionId, responseId, groups, includeResponseToGroups = true }) {
  if (!userId) throw new Error('userId is required');
  if (!sessionId) throw new Error('sessionId is required');
  if (!responseId && !Array.isArray(groups)) throw new Error('Either responseId or groups must be provided');

  const db = await getDocumentStorage();

  // Compute user-scoped session doc
  const scopedSessionsPath = projectScopedCollectionPath(userId, projectId, 'convo.sessions');
  const sessionDoc = scopedSessionsPath+'/'+String(sessionId);

  // Resolve groups if only responseId provided
  if (!groups) {
    const respPath = sessionDoc+'/collapsed/'+String(responseId);
    const snap = await db.get(respPath);
    if (!snap) throw new Error(`CollapseResponse not found: userId=${userId}, sessionId=${sessionId}, responseId=${responseId}`);
    const data = snap.data || {};

    // Some writers store groups at the top-level, others under a `value` map.
    let resolvedGroups = [];
    if (Array.isArray(data.groups)) {
      resolvedGroups = data.groups;
    } else if (data.value && Array.isArray(data.value.groups)) {
      resolvedGroups = data.value.groups;
    }

    groups = resolvedGroups;
  }

  const ts = nowSeconds();
  const collapsedIdxDoc = sessionDoc+'/indexes/collapsed';

  // Prepare writes
  const ops = [];
  const responseGroupNames = [];

  // Aggregate message->groups mapping to minimize per-message writes
  const perMessageGroupsMap = new Map(); // messageDocId -> { [GROUP_NAME]: { responseId, updated_at } }

  for (const group of groups) {
    const name = sanitizeGroupName(group?.name);
    if (!name) continue;

    const items = Array.isArray(group?.items) ? group.items : [];
    const messageItems = items.filter((it) => it && it.type === 'message' && it.id);

    // groupToResponse upsert
    const gtrRef = collapsedIdxDoc+'/groupToResponse/'+name;
    ops.push({ path: gtrRef, data: { responseId: responseId || 'unknown', updated_at: ts, size: items.length }, type: 'set', options: { merge: true } });

    responseGroupNames.push(name);

    for (const it of messageItems) {
      const messageDocId = String(it.id);
      if (!perMessageGroupsMap.has(messageDocId)) perMessageGroupsMap.set(messageDocId, {});
      const groupMap = perMessageGroupsMap.get(messageDocId);
      groupMap[name] = { responseId: responseId || 'unknown', updated_at: ts };
    }
  }

  // Build messageToGroups writes (prefer merge map, fallback to byMessage/* when too many groups)
  for (const [messageDocId, groupsMap] of perMessageGroupsMap.entries()) {
    const groupNames = Object.keys(groupsMap);
    if (groupNames.length === 0) continue;

    if (groupNames.length <= MAX_GROUPS_PER_MESSAGE) {
      const mtgRef = collapsedIdxDoc+'/messageToGroups/'+messageDocId;
      ops.push({ path: mtgRef, data: { groups: groupsMap }, type: 'deepMergeGroups' });
    } else {
      // Fallback: split per-message keys into child docs to avoid large document
      for (const gName of groupNames) {
        const byMsgRef = collapsedIdxDoc+'/byMessage/'+messageDocId+'/groups/'+gName;
        ops.push({ path: byMsgRef, data: groupsMap[gName], type: 'set', options: { merge: true } });
      }
    }
  }

  // Optional reverse mapping for cleanup
  if (includeResponseToGroups && responseGroupNames.length > 0) {
    const r2gRef = collapsedIdxDoc+'/responseToGroups/'+(responseId || 'unknown');
    ops.push({ path: r2gRef, data: { groups: responseGroupNames, updated_at: ts }, type: 'set', options: { merge: true } });
  }

  await commitWritesInChunks(db, ops);

  return { indexed_groups: responseGroupNames.length, indexed_messages: perMessageGroupsMap.size, batches: Math.ceil(ops.length / BATCH_WRITE_LIMIT) };
}

// Set the UI-expanded state for a collapsed group (idempotent)
// Body: { sessionId: string, group: string, expanded: boolean, responseId?: string }
router.post('/collapse/state/set', async (req, res) => {
  try {
    const hintedUserId = req?.body?.userId || req?.query?.userId || req?.headers?.['x-user-id'] || req?.userId;
    const userId = hintedUserId ? String(hintedUserId) : (await getUserIdFromReq(req));
    if (!userId) return res.status(401).json({ ok: false, error: 'Unauthorized: missing or invalid user' });

    const { sessionId, group, expanded, responseId } = req.body || {};

    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ ok: false, error: 'sessionId (string) is required' });
    }
    if (group === undefined || group === null || String(group).trim() === '') {
      return res.status(400).json({ ok: false, error: 'group (string) is required' });
    }
    if (typeof expanded !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'expanded (boolean) is required' });
    }

    const db = await getDocumentStorage();
    const scopedSessionsPath = projectScopedCollectionPath(userId, req.projectId, 'convo.sessions');
    const sessionDoc = scopedSessionsPath+'/'+String(sessionId);
    const collapsedIdxDoc = sessionDoc+'/indexes/collapsed';

    const name = sanitizeGroupName(group);
    if (!name) {
      return res.status(400).json({ ok: false, error: 'group normalized name is empty/invalid' });
    }

    const ts = nowSeconds();

    // Store state under indexes/collapsed/groupState/{GROUP}
    const stateRef = collapsedIdxDoc+'/groupState/'+name;
    const data = { expanded: Boolean(expanded), updated_at: ts };
    if (responseId) data.responseId = String(responseId);

    await db.put(stateRef,data,{merge:true});

    return res.status(200).json({ ok: true, group: name, expanded: Boolean(expanded), updated_at: ts });
  } catch (err) {
    console.error('Error in collapse state set:', err);
    return res.status(400).json({ ok: false, error: err?.message || 'Failed to set collapsed group state' });
  }
});

router.post('/collapse/indexer/run', async (req, res) => {
  try {
    // Prefer explicit userId passed by backend-auth workflows, then fall back
    const hintedUserId = req?.body?.userId || req?.query?.userId || req?.headers?.['x-user-id'] || req?.userId;
    const userId = hintedUserId ? String(hintedUserId) : (await getUserIdFromReq(req));
    if (!userId) return res.status(401).json({ ok: false, error: 'Unauthorized: missing or invalid user' });
    const projectId = req.projectId;

    const { sessionId, responseId, groups, includeResponseToGroups } = req.body || {};
    const result = await indexCollapseGroups({ userId, projectId, sessionId, responseId, groups, includeResponseToGroups: includeResponseToGroups !== false });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('Error in collapse indexer:', err);
    return res.status(400).json({ ok: false, error: err?.message || 'Failed to index collapsed response' });
  }
});

export default router;
export { indexCollapseGroups };
