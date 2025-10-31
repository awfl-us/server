// loadConvoHistory.js: Endpoint to load and ingest all conversation trees from a JSON array file in Google Cloud Storage into Firestore under convo.sessions
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import express from 'express';
import { Storage } from '@google-cloud/storage';
import path from 'path';

if (!getApps().length) {
  initializeApp();
}
const db = getFirestore();
const router = express.Router();
const storage = new Storage();

function getLatestBranchIds(mapping) {
  let rootNode = null;
  for (const [id, node] of Object.entries(mapping)) {
    if (!node.parent) {
      rootNode = id;
      break;
    }
  }
  let ids = [];
  let current = rootNode;
  while (current && mapping[current]) {
    ids.push(current);
    const children = mapping[current].children || [];
    current = children.length ? children[children.length - 1] : null;
  }
  return ids;
}

// POST /loadConvoHistory
// { "bucket": "bucket-name", "objectName": "conversations.json", "userId": "abc123" }
router.post('/loadConvoHistory', async (req, res) => {
  try {
    const { objectName, userId } = req.body;
    if (!objectName || !userId) {
      return res.status(400).json({ error: 'Missing objectName or userId' });
    }

    const bucket = "topaigents-gpt-convo-history";

    // Download file from GCS
    const file = storage.bucket(bucket).file(objectName);
    const [contents] = await file.download();
    const fileContent = contents.toString('utf-8');
    const convosArray = JSON.parse(fileContent);
    if (!Array.isArray(convosArray)) {
      return res.status(400).json({ error: 'Expected an array of conversations in the file' });
    }
    let totalLoaded = 0;
    let totalDiscardedMessages = 0;
    for (const convoJson of convosArray) {
      const sessionId = convoJson.conversation_id;
      if (!sessionId || !convoJson.mapping) {
        continue;
      }
      // Find latest branch nodes (IDs)
      const latestBranchIds = new Set(getLatestBranchIds(convoJson.mapping));
      // All message nodes: those with a message property
      const allMessageNodes = Object.values(convoJson.mapping).filter(node => node.message);
      // Discarded messages: not in latest branch
      const discardedMessages = allMessageNodes.filter(node => !latestBranchIds.has(node.id));
      totalDiscardedMessages += discardedMessages.length;
      // Only import latest branch
      const branchNodes = Array.from(latestBranchIds).map(id => convoJson.mapping[id]);
      const messages = branchNodes.map(node => {
        const msg = node.message || {};
        let content = '';
        if (msg.content && msg.content.parts && Array.isArray(msg.content.parts)) {
          content = msg.content.parts.join('\n');
        }
        let role = msg.author ? msg.author.role : 'user';
        if (role == "tool") role = "system";
        return {
          id: msg.id,
          role: role,
          content,
          create_time: msg.create_time
        };
      });
      // Write session doc with conversation properties EXCEPT mapping
      const sessionDoc = {
        title: convoJson.title,
        create_time: convoJson.create_time,
        update_time: convoJson.update_time,
        current_node: convoJson.current_node,
        conversation_id: convoJson.conversation_id,
        model_slug: convoJson.model_slug,
        is_archived: convoJson.is_archived,
        user_id: userId
      };
      await db.collection('convo.sessions').doc(sessionId).set(sessionDoc, { merge: true });
      // Write messages on latest branch
      const collectionPath = `convo.sessions/${sessionId}/messages`;
      const batch = db.batch();
      messages.forEach((msg, idx) => {
        let docId;
        if (msg.id) {
          docId = msg.id;
        } else {
          docId = String(idx);
        }
        batch.set(db.collection(collectionPath).doc(docId), { create_time: msg.create_time, value: msg }, { merge: true });
      });
      await batch.commit();
      totalLoaded++;
    }
    res.status(200).json({ loaded: totalLoaded, sessions: convosArray.length, discarded_messages: totalDiscardedMessages });
  } catch (err) {
    console.error('Failed to load conversations:', err);
    res.status(500).json({ error: 'Failed to load conversations: ' + err.message });
  }
});

export default router;