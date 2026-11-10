import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { getFirestore } from 'firebase-admin/firestore';
import { projectDoc } from '../projects/util.js';
import { resolveGoogleCloudAccessToken } from './service.js';
import { resolveGithubAppCredential } from '../githubApp/service.js';
import { mintWorkspaceToken } from '../workspace/storageTokens.js';

const router = express.Router();
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

export function consumerCredentialPayload(google, github) {
  // Pass the actual remaining Google lifetime. The consumer uses this value
  // to schedule its next refresh; hardcoded one-hour estimates are unsafe.
  return {
    ...(google ? { accessToken: google.accessToken, cloudProjectId: google.cloudProjectId,
      expiresIn: google.expiresIn } : {}),
    ...(github ? { githubToken: github.token } : {}),
  };
}

async function authenticateConsumer(req) {
  const { userId, projectId, consumerId } = req.body || {};
  const capability = String(req.get('x-awfl-consumer-credential') || '');
  if (!userId || !projectId || !consumerId || !/^[a-f0-9]{64}$/.test(capability)) {
    return { status: 401 };
  }
  const snap = await projectDoc(userId, projectId).get();
  const data = snap.data();
  const lock = data?.consumerLock;
  const grant = data?.consumerCredentialRefresh;
  const actual = createHash('sha256').update(capability).digest();
  const expected = /^[a-f0-9]{64}$/.test(grant?.hash || '') ? Buffer.from(grant.hash, 'hex') : Buffer.alloc(32);
  if (!snap.exists || !lock || lock.consumerId !== consumerId || lock.expiresAt <= Date.now() ||
      grant?.consumerId !== consumerId || !timingSafeEqual(actual, expected)) return { status: 403 };
  return { userId, projectId, consumerId };
}

router.post('/refresh', async (req, res) => {
  try {
    const authenticated = await authenticateConsumer(req);
    if (authenticated.status) return res.sendStatus(authenticated.status);
    const { userId, projectId } = authenticated;
    const db = getFirestore();
    const [google, github] = await Promise.all([
      resolveGoogleCloudAccessToken({ userId, projectId, db }),
      resolveGithubAppCredential({ userId, projectId, db }),
    ]);
    if (!google && !github) return res.status(404).json({ error: 'No refreshable credentials connected' });
    // Only short-lived credentials are returned, never OAuth refresh tokens or app keys.
    return res.json(consumerCredentialPayload(google, github));
  } catch (error) {
    console.warn('[consumer-credentials] refresh unavailable', error?.name || 'Error');
    return res.status(503).json({ error: 'Credential refresh unavailable' });
  }
});

router.post('/storage', async (req, res) => {
  try {
    const authenticated = await authenticateConsumer(req);
    if (authenticated.status) return res.sendStatus(authenticated.status);
    // Only the server can choose the bucket and prefix. User-provided GCS
    // identifiers are never accepted by this broker.
    const bucket = process.env.AWFL_WORKSPACE_GCS_BUCKET || process.env.GCS_BUCKET;
    if (!bucket) return res.status(503).json({ error: 'Workspace storage is not configured' });
    return res.json(await mintWorkspaceToken({ ...authenticated, bucket }));
  } catch (error) {
    console.warn('[consumer-credentials] storage token unavailable', error?.name || 'Error');
    return res.status(503).json({ error: 'Workspace storage credential unavailable' });
  }
});
export default router;
