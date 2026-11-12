import express from 'express';
import { getFirestore } from 'firebase-admin/firestore';
import { API_KEY_LIFETIME_MS, API_KEY_SCOPES, apiKeyMetadata, generateApiKey } from './core.js';

const router = express.Router();

function collection() {
  return getFirestore().collection('apiKeys');
}

router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// User-scoped management endpoints. The parent router resolves Firebase,
// OAuth and API keys to the same user identity.
router.get('/', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const snap = await collection().where('userId', '==', req.userId).get();
    const keys = snap.docs.map((doc) => apiKeyMetadata(doc.data()))
      .sort((a, b) => b.createdAt - a.createdAt);
    return res.json({ keys });
  } catch (error) {
    console.error('[api-keys] list failed', error?.name || 'Error');
    return res.status(500).json({ error: 'Failed to list API keys' });
  }
});

router.post('/', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });

  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 80) {
    return res.status(400).json({ error: 'Key name must contain 1–80 characters' });
  }

  try {
    const { id, token, hash, last4 } = generateApiKey();
    const createdAt = Date.now();
    const record = {
      id,
      userId: req.userId,
      name,
      hash,
      last4,
      scopes: [...API_KEY_SCOPES],
      createdAt,
      expiresAt: createdAt + API_KEY_LIFETIME_MS,
    };
    await collection().doc(id).create(record);
    // The raw token is returned exactly once; subsequent reads show metadata.
    return res.status(201).json({ key: token, apiKey: apiKeyMetadata(record) });
  } catch (error) {
    console.error('[api-keys] create failed', error?.name || 'Error');
    return res.status(500).json({ error: 'Failed to create API key' });
  }
});

router.delete('/:id', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!/^[0-9a-f]{24}$/.test(req.params.id)) {
    return res.status(404).json({ error: 'API key not found' });
  }

  try {
    const ref = collection().doc(req.params.id);
    const deleted = await getFirestore().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.data()?.userId !== req.userId) return false;
      tx.delete(ref);
      return true;
    });
    if (!deleted) return res.status(404).json({ error: 'API key not found' });
    return res.json({ ok: true });
  } catch (error) {
    console.error('[api-keys] revoke failed', error?.name || 'Error');
    return res.status(500).json({ error: 'Failed to revoke API key' });
  }
});

export default router;
