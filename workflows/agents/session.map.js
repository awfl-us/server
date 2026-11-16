import express from 'express';
import { getDocumentStorage } from '../../storage/service.js';
import { userScopedCollectionPath, sessionMapDocPath, DEFAULT_TOOLS, getFileDefinedAgentById, linkAgentSession } from './common.js';

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

    const linked = await linkAgentSession(userId, req.projectId, sessionId, trimmedId);
    if (!linked) return res.status(404).json({ error: 'Agent not found' });

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
    const storage = await getDocumentStorage();
    const documentPath = sessionMapDocPath(userId, req.projectId, sessionId);
    const snap = await storage.get(documentPath);
    if (!snap) return res.status(404).json({ error: 'Session not linked to an agent' });

    const { agentId } = snap.data;
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
    const storage = await getDocumentStorage();
    const documentPath = sessionMapDocPath(userId, req.projectId, sessionId);
    const snap = await storage.get(documentPath);
    if (!snap) return res.status(404).json({ error: 'Session not linked to an agent' });

    await storage.delete(documentPath);
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

    const storage = await getDocumentStorage();
    const mapSnap = await storage.get(sessionMapDocPath(userId, req.projectId, sessionId));
    if (!mapSnap) return res.status(404).json({ error: 'Session not linked to an agent' });

    const { agentId } = mapSnap.data;

    // Try DB first
    const agentSnap = await storage.get(userScopedCollectionPath(userId, `agents/${agentId}`));

    let tools;
    if (agentSnap) {
      const data = agentSnap.data || {};
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
