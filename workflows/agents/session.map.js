import express from 'express';
import { db, userScopedCollectionPath, sessionMapDocPath, DEFAULT_TOOLS, getFileDefinedAgentById } from './common.js';

const router = express.Router();

// Link or update a session to an agent
// PUT /agents/session/:sessionId  Body: { agentId: string }
router.put('/session/:sessionId', async (req, res) => {
  try {
    const userId = req.userId;
    const { sessionId } = req.params;
    const { agentId } = req.body || {};
    if (!agentId || typeof agentId !== 'string') {
      return res.status(400).json({ error: 'agentId is required' });
    }

    const trimmedId = agentId.trim();

    // Validate agent exists: DB first, then file-defined
    const agentRef = db.doc(userScopedCollectionPath(userId, `agents/${trimmedId}`));
    const agentSnap = await agentRef.get();
    if (!agentSnap.exists) {
      const fileAgent = await getFileDefinedAgentById(trimmedId);
      if (!fileAgent) return res.status(404).json({ error: 'Agent not found' });
    }

    const docRef = db.doc(sessionMapDocPath(userId, req.projectId, sessionId));
    const now = Date.now();
    const data = { sessionId, agentId: trimmedId, updated: now, created: now };

    await docRef.set(data, { merge: true });
    return res.status(200).json({ sessionId, agentId: trimmedId });
  } catch (err) {
    console.error('[agents] link session failed', err);
    return res.status(500).json({ error: 'Failed to link session to agent' });
  }
});

// Get mapping for a session
// GET /agents/session/:sessionId -> { sessionId, agentId }
router.get('/session/:sessionId', async (req, res) => {
  try {
    const userId = req.userId;
    const { sessionId } = req.params;
    const docRef = db.doc(sessionMapDocPath(userId, req.projectId, sessionId));
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Session not linked to an agent' });

    const { agentId } = snap.data();
    return res.status(200).json({ sessionId, agentId });
  } catch (err) {
    console.error('[agents] get session mapping failed', err);
    return res.status(500).json({ error: 'Failed to get session mapping' });
  }
});

// Delete mapping for a session
// DELETE /agents/session/:sessionId -> { ok: true }
router.delete('/session/:sessionId', async (req, res) => {
  try {
    const userId = req.userId;
    const { sessionId } = req.params;
    const docRef = db.doc(sessionMapDocPath(userId, req.projectId, sessionId));
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Session not linked to an agent' });

    await docRef.delete();
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[agents] delete session mapping failed', err);
    return res.status(500).json({ error: 'Failed to delete session mapping' });
  }
});

// Get tools by session mapping
// GET /agents/session/:sessionId/tools -> { tools: string[] }
router.get('/session/:sessionId/tools', async (req, res) => {
  try {
    const userId = req.userId;
    const { sessionId } = req.params;

    const mapRef = db.doc(sessionMapDocPath(userId, req.projectId, sessionId));
    const mapSnap = await mapRef.get();
    if (!mapSnap.exists) return res.status(404).json({ error: 'Session not linked to an agent' });

    const { agentId } = mapSnap.data();

    // Try DB first
    const agentRef = db.doc(userScopedCollectionPath(userId, `agents/${agentId}`));
    const agentSnap = await agentRef.get();

    let tools;
    if (agentSnap.exists) {
      const data = agentSnap.data() || {};
      if (Object.prototype.hasOwnProperty.call(data, 'tools')) {
        tools = Array.isArray(data.tools) ? data.tools : [];
      } else {
        tools = DEFAULT_TOOLS;
      }
    } else {
      // Fallback to file-defined agents
      const fileAgent = await getFileDefinedAgentById(agentId);
      if (!fileAgent) return res.status(404).json({ error: 'Agent not found' });
      if (Object.prototype.hasOwnProperty.call(fileAgent, 'tools')) {
        tools = Array.isArray(fileAgent.tools) ? fileAgent.tools : [];
      } else {
        tools = DEFAULT_TOOLS;
      }
    }

    return res.status(200).json({ tools });
  } catch (err) {
    console.error('[agents] get tools by session failed', err);
    return res.status(500).json({ error: 'Failed to get tools by session' });
  }
});

export default router;
