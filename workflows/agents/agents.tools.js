import express from 'express';
import { db, userScopedCollectionPath, normalizeToolsInput, uniqueMerge, removeFromList, DEFAULT_TOOLS } from './common.js';

const router = express.Router();

// Assign tools to an agent (add)
// Body: { tools: string | string[] }
router.post('/:id/tools', async (req, res) => {
  try {
    const userId = req.userId;
    const { id } = req.params;
    const toAdd = normalizeToolsInput(req.body?.tools);
    if (!toAdd.length) return res.status(400).json({ error: 'tools is required (string or array of strings)' });

    const docRef = db.doc(userScopedCollectionPath(userId, `agents/${id}`));
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Agent not found' });

    const current = snap.data()?.tools || [];
    const tools = uniqueMerge(current, toAdd);

    await docRef.set({ tools, updated: Date.now() }, { merge: true });
    return res.status(200).json({ tools });
  } catch (err) {
    console.error('[agents] add tools failed', err);
    return res.status(500).json({ error: 'Failed to add tools' });
  }
});

// Remove tools from an agent
// Body: { tools: string | string[] }
router.delete('/:id/tools', async (req, res) => {
  try {
    const userId = req.userId;
    const { id } = req.params;
    const toRemove = normalizeToolsInput(req.body?.tools);
    if (!toRemove.length) return res.status(400).json({ error: 'tools is required (string or array of strings)' });

    const docRef = db.doc(userScopedCollectionPath(userId, `agents/${id}`));
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Agent not found' });

    const current = snap.data()?.tools || [];
    const tools = removeFromList(current, toRemove);

    await docRef.set({ tools, updated: Date.now() }, { merge: true });
    return res.status(200).json({ tools });
  } catch (err) {
    console.error('[agents] remove tools failed', err);
    return res.status(500).json({ error: 'Failed to remove tools' });
  }
});

// List tools for an agent (names only)
router.get('/:id/tools', async (req, res) => {
  try {
    const userId = req.userId;
    const { id } = req.params;

    // Special case: for the sentinel agentId 'default', always return DEFAULT_TOOLS
    if (id === 'default') {
      return res.status(200).json({ tools: DEFAULT_TOOLS });
    }

    const docRef = db.doc(userScopedCollectionPath(userId, `agents/${id}`));
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Agent not found' });

    const data = snap.data() || {};

    let tools;
    if (Object.prototype.hasOwnProperty.call(data, 'tools')) {
      tools = Array.isArray(data.tools) ? data.tools : [];
    } else {
      // If tools have never been defined for this agent, return default set
      tools = DEFAULT_TOOLS;
    }

    return res.status(200).json({ tools });
  } catch (err) {
    console.error('[agents] list tools failed', err);
    return res.status(500).json({ error: 'Failed to list tools' });
  }
});

export default router;
