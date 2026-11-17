import { providerDocumentDb } from '../../storage/legacyBridge.js';
import express from 'express';
import { getFirestore } from 'firebase-admin/firestore';
import { userScopedCollectionPath } from '../utils.js';
import { encryptString } from '../crypto.js';

const router = express.Router();
const db = providerDocumentDb(getFirestore);

function credsCollection(userId) {
  // User-scoped storage shared across projects
  return db.collection(userScopedCollectionPath(userId, 'creds'));
}

// Create or update a credential for a provider (e.g., "openai")
// Body: { value: string }
router.post('/:provider', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });

    const { provider } = req.params;
    const { value } = req.body || {};
    if (!provider || typeof provider !== 'string') {
      return res.status(400).json({ error: 'Invalid provider' });
    }
    if (!value || typeof value !== 'string') {
      return res.status(400).json({ error: 'Missing value' });
    }

    const now = Date.now();
    const enc = encryptString(value);
    const last4 = value.slice(-4);

    const docRef = credsCollection(userId).doc(provider);
    const data = {
      id: provider,
      provider,
      enc,
      last4,
      created: now,
      updated: now,
    };

    await docRef.set(data, { merge: true });

    return res.status(201).json({
      cred: {
        id: provider,
        provider,
        last4,
        updated: now,
      },
    });
  } catch (err) {
    console.error('[creds] set failed', err?.message || err);
    return res.status(500).json({ error: 'Failed to set credential' });
  }
});

// Get list of credentials (metadata only)
router.get('/', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });

    const snap = await credsCollection(userId).get();
    const items = snap.docs.map((d) => {
      const v = d.data() || {};
      return {
        id: v.id || d.id,
        provider: v.provider || d.id,
        last4: v.last4 || null,
        updated: v.updated || null,
        hasValue: Boolean(v.enc && v.enc.ct),
      };
    });

    return res.status(200).json({ creds: items });
  } catch (err) {
    console.error('[creds] list failed', err?.message || err);
    return res.status(500).json({ error: 'Failed to list credentials' });
  }
});

// Delete a credential
router.delete('/:provider', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });

    const { provider } = req.params;
    const docRef = credsCollection(userId).doc(provider);
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Credential not found' });

    await docRef.delete();
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[creds] delete failed', err?.message || err);
    return res.status(500).json({ error: 'Failed to delete credential' });
  }
});

export default router;
