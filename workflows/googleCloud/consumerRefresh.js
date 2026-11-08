import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { getFirestore } from 'firebase-admin/firestore';
import { projectDoc } from '../projects/util.js';
import { resolveGoogleCloudAccessToken } from './service.js';

const router = express.Router();
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.post('/', async (req, res) => {
  const { userId, projectId, consumerId } = req.body || {};
  const capability = String(req.get('x-awfl-consumer-credential') || '');
  if (!userId || !projectId || !consumerId || !/^[a-f0-9]{64}$/.test(capability)) {
    return res.sendStatus(401);
  }
  try {
    const snap = await projectDoc(userId, projectId).get();
    const data = snap.data();
    const lock = data?.consumerLock;
    const grant = data?.consumerCredentialRefresh;
    const actual = createHash('sha256').update(capability).digest();
    const expected = /^[a-f0-9]{64}$/.test(grant?.hash || '') ? Buffer.from(grant.hash, 'hex') : Buffer.alloc(32);
    if (!snap.exists || !lock || lock.consumerId !== consumerId || lock.expiresAt <= Date.now() ||
        grant?.consumerId !== consumerId || !timingSafeEqual(actual, expected)) return res.sendStatus(403);
    const credential = await resolveGoogleCloudAccessToken({ userId, projectId, db: getFirestore() });
    if (!credential) return res.status(404).json({ error: 'Google Cloud connection unavailable' });
    // Access tokens are short-lived; never return the stored OAuth refresh token.
    return res.json({ accessToken: credential.accessToken, cloudProjectId: credential.cloudProjectId, expiresIn: 3300 });
  } catch (error) {
    console.warn('[consumer-credentials] refresh unavailable', error?.name || 'Error');
    return res.status(503).json({ error: 'Credential refresh unavailable' });
  }
});
export default router;
