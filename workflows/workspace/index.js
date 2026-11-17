import express from 'express';
import { getDocumentStorage } from '../../storage/service.js';
import { randomUUID } from 'node:crypto';
import { projectScopedCollectionPath } from '../userAuth.js';
import { projectPath } from '../projects/util.js';

const router = express.Router();
router.use(express.json());

function has(v) { return v !== undefined && v !== null; }

const workspaceCol=(userId,projectId)=>projectScopedCollectionPath(userId,projectId,'workspaces');
const workspaceDoc=(userId,projectId,id)=>`${workspaceCol(userId,projectId)}/${id}`;

function parseTtlMs(q) {
  const ttlMsParam = q.ttlMs ?? q.ttl_ms ?? q.ttlms;
  const ttlSecParam = q.ttlSec ?? q.ttl_sec ?? q.ttl;
  let ttlMs = undefined;
  if (has(ttlMsParam)) ttlMs = Number(ttlMsParam);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    const asSec = has(ttlSecParam) ? Number(ttlSecParam) : undefined;
    if (Number.isFinite(asSec) && asSec > 0) ttlMs = asSec * 1000;
  }
  // Default TTL: 5 minutes
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) ttlMs = 5 * 60 * 1000;
  return Math.floor(ttlMs);
}

// REGISTER: Create a workspace (project-wide when sessionId is null/omitted, or session-scoped when provided)
// Body: { projectId: string, sessionId?: string }
// Returns: { id }
router.post('/register', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });

    const { projectId } = req.body || {};
    let { sessionId } = req.body || {};

    if (!projectId || typeof projectId !== 'string') return res.status(400).json({ error: 'projectId is required' });

    const db=await getDocumentStorage();
    const pSnap = await db.get(projectPath(userId, String(projectId).trim()));
    if (!pSnap) return res.status(400).json({ error: 'Project not found' });

    const id=randomUUID().replaceAll('-','');
    const now = Date.now();

    const data = {
      id,
      projectId: String(projectId).trim(),
      sessionId: (typeof sessionId === 'string' && sessionId.trim().length > 0) ? sessionId.trim() : null,
      live_at: now,
      created: now,
      updated: now,
    };

    await db.create(workspaceDoc(userId,req.projectId,id),data);

    return res.status(201).json({ id });
  } catch (err) {
    console.error('[workspace] register failed', err);
    return res.status(500).json({ error: 'Failed to register workspace' });
  }
});

// RESOLVE: Fetch the live workspace for a given (projectId, sessionId?) with fallback to project-wide if session-scoped not found
// Query: ?projectId=...&sessionId=...&ttlMs=...
// Returns: { workspace } or 404 when none live within TTL
router.get('/resolve', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });

    const { projectId } = req.query || {};
    let { sessionId } = req.query || {};
    if (!projectId || typeof projectId !== 'string') return res.status(400).json({ error: 'projectId is required' });

    const ttlMs = parseTtlMs(req.query || {});
    const cutoff = Date.now() - ttlMs;

    const db=await getDocumentStorage();
    const col=workspaceCol(userId,req.projectId);

    const runQuery=async(pid,sid)=>{
      const docs=await db.query({collection:col,where:[
        {field:'projectId',op:'==',value:pid},
        {field:'live_at',op:'>=',value:cutoff},
        {field:'sessionId',op:'==',value:sid},
      ],orderBy:{field:'live_at',direction:'desc'},limit:1});
      return docs[0]?.data??null;
    };

    sessionId = typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId.trim() : undefined;
    const pid = String(projectId).trim();

    let workspace = null;
    if (sessionId) {
      workspace = await runQuery(pid, sessionId);
      if (!workspace) workspace = await runQuery(pid, null);
    } else {
      workspace = await runQuery(pid, null);
    }

    if (!workspace) return res.status(404).json({ error: 'No live workspace found' });

    return res.status(200).json({ workspace });
  } catch (err) {
    console.error('[workspace] resolve failed', err);
    return res.status(500).json({ error: 'Failed to resolve workspace' });
  }
});

// HEARTBEAT: Update live_at to keep the workspace marked live
// POST /:id/heartbeat
router.post('/:id/heartbeat', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });

    const { id } = req.params;
    const db=await getDocumentStorage();
    const path=workspaceDoc(userId,req.projectId,id);
    const snap=await db.get(path);
    if (!snap) return res.status(404).json({ error: 'Workspace not found' });

    const now = Date.now();
    await db.put(path,{live_at:now,updated:now},{merge:true});
    return res.status(200).json({ ok: true, live_at: now });
  } catch (err) {
    console.error('[workspace] heartbeat failed', err);
    return res.status(500).json({ error: 'Failed to heartbeat workspace' });
  }
});

// List workspaces (debug/ops)
router.get('/', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });

    const { limit = 50, order = 'desc' } = req.query || {};
    const snap=await (await getDocumentStorage()).query({collection:workspaceCol(userId,req.projectId),
      orderBy:{field:'created',direction:order==='asc'?'asc':'desc'},
      limit:Math.min(Math.max(Number(limit)||50,1),200)});
    const workspaces=snap.map(d=>d.data);
    return res.status(200).json({ workspaces });
  } catch (err) {
    console.error('[workspace] list failed', err);
    return res.status(500).json({ error: 'Failed to list workspaces' });
  }
});

// Get workspace by id (debug/ops)
router.get('/:id', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });

    const { id } = req.params;
    const snap=await (await getDocumentStorage()).get(workspaceDoc(userId,req.projectId,id));
    if (!snap) return res.status(404).json({ error: 'Workspace not found' });
    return res.status(200).json({ workspace: snap.data });
  } catch (err) {
    console.error('[workspace] get failed', err);
    return res.status(500).json({ error: 'Failed to get workspace' });
  }
});

// Delete workspace (debug/ops)
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });
    const { id } = req.params;

    const db=await getDocumentStorage();
    const path=workspaceDoc(userId,req.projectId,id);
    const wsSnap=await db.get(path);
    if (!wsSnap) return res.status(404).json({ error: 'Workspace not found' });

    await db.delete(path);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[workspace] delete failed', err);
    return res.status(500).json({ error: 'Failed to delete workspace' });
  }
});

export default router;
