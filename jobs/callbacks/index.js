import express from 'express';
import { getFirestore } from 'firebase-admin/firestore';
import { userScopedCollectionPath } from '../../workflows/utils.js';
import { nativeCallbackIdFromUrl, registerNativeCallback } from '../../workflows/native/callbackEffects.js';

const db = getFirestore();
const router = express.Router();
router.use(express.json());

function isHttpUrl(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// POST /jobs/callbacks — create a callback record (user-scoped)
// Body: { callback_url: string, name?: string, description?: string, metadata?: object }
router.post('/', async (req, res) => {
  try {
    const userId = req.userId;
    const { callback_url, name, description, metadata } = req.body || {};

    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });

    if (!callback_url || typeof callback_url !== 'string' || !isHttpUrl(callback_url)) {
      return res.status(400).json({ error: 'callback_url must be a valid http(s) URL' });
    }

    const colPath = userScopedCollectionPath(userId, 'callbacks');
    const colRef = db.collection(colPath);

    // Native creates its callback in the SAME user-scoped collection first.
    // The traditional saveCallback step registers that already-existing ID,
    // rather than creating a second callback record or external callback.
    const nativeId = nativeCallbackIdFromUrl(
      callback_url, process.env.AWFL_NATIVE_JOBS_URL || '');
    if (nativeId) {
      try {
        const existing = await registerNativeCallback({
          db, callbackUrl: callback_url,
          jobsOrigin: process.env.AWFL_NATIVE_JOBS_URL,
          identity: { userId, projectId: req.projectId },
        });
        return res.status(201).json(existing);
      } catch {
        return res.status(404).json({ error: 'Native callback not registered' });
      }
    }

    const doc = await colRef.add({
      callback_url: String(callback_url),
      name: name ? String(name) : null,
      description: description ? String(description) : null,
      metadata: metadata && typeof metadata === 'object' ? metadata : null,
      created_at: Date.now(),
      created_by: userId,
      called_at: null,
      last_status: null,
      last_error: null,
    });

    res.status(201).json({ id: doc.id, callback_url });
  } catch (err) {
    console.error('[jobs/callbacks:create] error', err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

export default router;