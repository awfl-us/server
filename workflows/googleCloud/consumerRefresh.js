import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { getFirestore } from 'firebase-admin/firestore';
import { projectDoc } from '../projects/util.js';
import { resolveGoogleCloudAccessToken } from './service.js';
import { resolveGithubAppCredential } from '../githubApp/service.js';
import { mintWorkspaceToken } from '../workspace/storageTokens.js';
import { mintUserCustomToken } from '../../jobs/producer/auth/firebaseTokens.js';
import { inspectK8sJob } from '../../jobs/producer/gke.js';

export function consumerCredentialPayload(google, github) {
  return {
    ...(google ? { accessToken: google.accessToken, cloudProjectId: google.cloudProjectId,
      expiresIn: google.expiresIn } : {}),
    ...(github ? { githubToken: github.token,
      ...(Number.isFinite(github.expiresIn) ? { githubExpiresIn: github.expiresIn } : {}) } : {}),
  };
}

/**
 * The consumer Job's capability is the stable secret across pod restarts.
 * Ordinary refresh and storage operations require the active project lock.
 * Firebase bootstrap may recover with a released/expired lock, but ONLY if
 * the capability is still the current grant and its Kubernetes Job still
 * exists. Never allow a different, active consumer to be displaced.
 */
export function createConsumerCredentialsRouter({
  readProject = (userId, projectId) => projectDoc(userId, projectId).get(),
  inspectJob = inspectK8sJob,
  mintFirebase = mintUserCustomToken,
  resolveGoogle = resolveGoogleCloudAccessToken,
  resolveGithub = resolveGithubAppCredential,
  mintStorage = mintWorkspaceToken,
  getDb = getFirestore,
} = {}) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  async function authenticateConsumer(req, { bootstrap = false } = {}) {
    const { userId, projectId, consumerId } = req.body || {};
    const capability = String(req.get('x-awfl-consumer-credential') || '');
    if (!userId || !projectId || !consumerId || !/^[a-f0-9]{64}$/.test(capability)) {
      return { status: 401 };
    }
    const snap = await readProject(userId, projectId);
    const data = snap.data();
    const lock = data?.consumerLock;
    const grant = data?.consumerCredentialRefresh;
    const actual = createHash('sha256').update(capability).digest();
    const expected = /^[a-f0-9]{64}$/.test(grant?.hash || '')
      ? Buffer.from(grant.hash, 'hex') : Buffer.alloc(32);
    if (!snap.exists || grant?.consumerId !== consumerId ||
        !timingSafeEqual(actual, expected)) return { status: 403 };

    if (!bootstrap) {
      if (!lock || lock.consumerId !== consumerId ||
          lock.expiresAt <= Date.now()) return { status: 403 };
    } else {
      if (lock && lock.consumerId !== consumerId &&
          lock.expiresAt > Date.now()) return { status: 403 };

      // Check actual Job existence, not the presence of an old credential
      // grant. An intentionally stopped/deleted Job may not bootstrap.
      const jobName = `consumer-${consumerId}`.slice(0, 63);
      const job = await inspectJob({
        namespace: process.env.K8S_NAMESPACE || 'awfl', jobName,
      });
      if (job?.state !== 'active' && job?.state !== 'pending') {
        return { status: 403 };
      }
    }
    return { userId, projectId, consumerId };
  }

  router.post('/firebase', async (req, res) => {
    try {
      const authenticated = await authenticateConsumer(req, { bootstrap: true });
      if (authenticated.status) return res.sendStatus(authenticated.status);
      // Firebase custom tokens are exchange-only and freshly minted at boot.
      const customToken = await mintFirebase({ uid: authenticated.userId });
      return res.json({ customToken });
    } catch (error) {
      console.warn('[consumer-credentials] Firebase bootstrap unavailable', error?.name || 'Error');
      return res.status(503).json({ error: 'Firebase bootstrap unavailable' });
    }
  });

  router.post('/refresh', async (req, res) => {
    try {
      const authenticated = await authenticateConsumer(req);
      if (authenticated.status) return res.sendStatus(authenticated.status);
      const { userId, projectId } = authenticated;
      const db = getDb();
      const [google, github] = await Promise.all([
        resolveGoogle({ userId, projectId, db }),
        resolveGithub({ userId, projectId, db }),
      ]);
      if (!google && !github) return res.status(404).json({ error: 'No refreshable credentials connected' });
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
      const bucket = process.env.AWFL_WORKSPACE_GCS_BUCKET || process.env.GCS_BUCKET;
      if (!bucket) return res.status(503).json({ error: 'Workspace storage is not configured' });
      return res.json(await mintStorage({ ...authenticated, bucket }));
    } catch (error) {
      console.warn('[consumer-credentials] storage token unavailable', error?.name || 'Error');
      return res.status(503).json({ error: 'Workspace storage credential unavailable' });
    }
  });
  return router;
}

export default createConsumerCredentialsRouter();
