import express from 'express';
import { getDocumentStorage } from '../../storage/service.js';
import { projectScopedCollectionPath } from '../userAuth.js';

const router = express.Router();
router.use(express.json({ limit: process.env.RELAY_EVENT_MAX_BYTES || '64kb' }));

function has(v) { return v !== undefined && v !== null; }

// GET /events/cursors — load project-wide and optional session-specific cursor
// Query: workspaceId? | projectId?, sessionId?
router.get('/', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });

    const db = await getDocumentStorage();

    const workspaceId = String(req.query.workspaceId || req.query.workspace_id || '').trim();
    let projectId = String(req.query.projectId || req.query.project_id || '').trim();
    let sessionId = String(req.query.sessionId || req.query.session_id || '').trim();

    if (workspaceId) {
      const wsPath = projectScopedCollectionPath(userId, req.projectId, `workspaces/${workspaceId}`);
      const wsSnap = await db.get(wsPath);
      if (!wsSnap) return res.status(404).json({ error: 'workspace not found' });
      const ws = wsSnap.data || {};
      if (!projectId) projectId = String(ws.projectId || '').trim();
      if (!sessionId && typeof ws.sessionId === 'string') sessionId = String(ws.sessionId || '').trim();
    }

    if (!projectId) return res.status(400).json({ error: 'projectId or workspaceId required' });

    const colPath = projectScopedCollectionPath(userId, req.projectId, 'cursors');
    const project = await db.get(`${colPath}/project`);
    const session = sessionId ? await db.get(`${colPath}/session:${sessionId}`) : null;

    res.json({ projectId, sessionId: sessionId || null,
      project: project?.data || null, session: session?.data || null });
  } catch (err) {
    console.error('[events GET /cursors] error', err);
    res.status(400).json({ error: String(err?.message || err) });
  }
});

// POST /events/cursors — save a project-wide and/or session-specific cursor
// Body: { projectId? | workspaceId?, sessionId?, eventId, timestamp, target?: 'project'|'session'|'both' }
router.post('/', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });

    const db = await getDocumentStorage();

    const body = req.body || {};
    const workspaceId = String(body.workspaceId || body.workspace_id || '').trim();
    let projectId = String(body.projectId || body.project_id || '').trim();
    let sessionId = String(body.sessionId || body.session_id || '').trim();

    if (workspaceId) {
      const wsPath = projectScopedCollectionPath(userId, req.projectId, `workspaces/${workspaceId}`);
      const wsSnap = await db.get(wsPath);
      if (!wsSnap) return res.status(404).json({ error: 'workspace not found' });
      const ws = wsSnap.data || {};
      if (!projectId) projectId = String(ws.projectId || '').trim();
      if (!sessionId && typeof ws.sessionId === 'string') sessionId = String(ws.sessionId || '').trim();
    }

    if (!projectId) return res.status(400).json({ error: 'projectId or workspaceId required' });

    const eventId = String(body.eventId || body.id || '').trim();
    const timestampRaw = has(body.timestamp) ? body.timestamp : body.create_time || body.time;
    const timestamp = typeof timestampRaw === 'number' ? String(timestampRaw) : String(timestampRaw || '').trim();

    if (!eventId) return res.status(400).json({ error: 'eventId required' });
    if (!timestamp) return res.status(400).json({ error: 'timestamp required' });

    const targetRaw = String(body.target || '').trim().toLowerCase();
    let targets;
    if (targetRaw === 'both') targets = ['project', 'session'];
    else if (targetRaw === 'project') targets = ['project'];
    else if (targetRaw === 'session') targets = ['session'];
    else targets = sessionId ? ['session'] : ['project'];

    if (targets.includes('session') && !sessionId) return res.status(400).json({ error: 'sessionId required for session-target cursor' });

    const colPath = projectScopedCollectionPath(userId, req.projectId, 'cursors');
    const updatedAt = new Date().toISOString();
    const writes=[];
    if(targets.includes('project'))writes.push({op:'put',path:`${colPath}/project`,
      data:{eventId,timestamp,updatedAt},options:{merge:true}});
    if(targets.includes('session'))writes.push({op:'put',path:`${colPath}/session:${sessionId}`,
      data:{eventId,timestamp,sessionId,updatedAt},options:{merge:true}});
    await db.batch(writes);

    res.status(200).json({ ok: true, projectId, sessionId: sessionId || null, updated: targets });
  } catch (err) {
    console.error('[events POST /cursors] error', err);
    res.status(400).json({ error: String(err?.message || err) });
  }
});

export default router;
