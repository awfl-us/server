import { randomBytes } from 'node:crypto';
import { requiredEnv, randomId } from './utils.js';
import { ensureWorkspaceId } from '../../workflows/workspace/service.js';
import { acquireConsumerLock, releaseConsumerLock, getConsumerLock } from '../../workflows/projects/lock.js';
import { ensureSubscription, addSubscriberBinding, deleteSubscription } from './pubsubAdmin.js';
import { sanitizeId, buildBaseContext, deriveEncryption } from './envBuilder.js';
import { startCloudRun } from './paths/cloudRun.js';
import { startGke } from './paths/gke.js';
import { startLocalDocker } from './paths/localDocker.js';
import { loadConsumerCredentials } from './credentials.js';
import { cancelStartupProgress } from './progress.js';

export async function startProjectConsumer({ userId, projectId, body = {} }) {
  let consumerId = null;
  let lockAcquired = false;
  const bestEffortRelease = async (ctx = {}) => {
    try {
      if (lockAcquired && consumerId) {
        await releaseConsumerLock({ userId: ctx.userId, projectId: ctx.projectId, consumerId });
      }
    } catch {}
  };

  try {
    if (!userId) return { status: 401, body: { error: 'Unauthorized: missing user context' } };
    if (!projectId) return { status: 400, body: { error: 'Missing x-project-id header' } };

    let workspaceId = String(body.workspaceId || body.workspace_id || '').trim();

    // Optional explicit GCS prefix to pass to producer/consumer
    const gcsPrefix = String(body.gcsPrefix || body.gcs_prefix || '').trim();

    // Optional consumer image override (for local sidecar, Cloud Run, or GKE consumer)
    const requestedConsumerImage = String(body.image || '').trim();
    if (requestedConsumerImage && /\s|["'`]/.test(requestedConsumerImage)) {
      return { status: 400, body: { error: 'Invalid image parameter' } };
    }

    // Session handling
    const requestedSessionId = String(body.sessionId || body.session_id || '').trim();
    const sessionIdForFilter = requestedSessionId; // may be '' (meaning no session filter)
    const sessionIdForWorkspace = requestedSessionId || undefined; // undefined -> project-wide workspace

    const since_id = String(body.since_id || '').trim();
    const since_time = String(body.since_time || '').trim();
    const leaseMs = Number.isFinite(Number(body.leaseMs)) ? Math.max(5000, Math.min(10 * 60 * 1000, Number(body.leaseMs))) : 10 * 60 * 1000;
    const workspaceTtlMs = Number.isFinite(Number(body.workspaceTtlMs)) ? Number(body.workspaceTtlMs) : undefined;

    if (!workspaceId) {
      try {
        workspaceId = await ensureWorkspaceId({ userId, projectId, sessionId: sessionIdForWorkspace, ttlMs: workspaceTtlMs });
      } catch (e) {
        return { status: 400, body: { error: 'Failed to resolve/create workspace', details: String(e?.message || e) } };
      }
    }

    const localDocker = Boolean(body.localDocker || process.env.PRODUCER_LOCAL_DOCKER);
    const localDockerImage = String(body.localDockerImage || process.env.PRODUCER_LOCAL_IMAGE || '').trim();

    const baseCtx = buildBaseContext({ body, localDocker });
    const { encKeyB64, encVer, encFp } = deriveEncryption({
      overrideKeyB64: body.ENC_KEY_B64 || body.enc_key_b64,
      overrideVer: body.ENC_VER || body.enc_ver,
    });

    consumerId = randomId('consumer');

    // Mint an external project lock token and id for this run
    const lockToken = randomBytes(32).toString('hex');
    const lockId = randomId('lock');

    const lock = await acquireConsumerLock({ userId, projectId, consumerId, leaseMs, consumerType: 'CLOUD' });
    if (!lock.ok && lock.conflict) {
      return { status: 202, body: { message: 'Lock held by another consumer', details: lock } };
    }
    lockAcquired = true;

    const sidecarEnabled = String(process.env.PRODUCER_SIDECAR_ENABLE || '').trim() === '1';
    const sidecarDefaultImage = process.env.PRODUCER_SIDECAR_CONSUMER_IMAGE || 'awfl-consumer:dev';
    const sidecarImage = requestedConsumerImage || sidecarDefaultImage;
    const sidecarArgsTemplate = process.env.PRODUCER_SIDECAR_DOCKER_ARGS || '';

    console.log('[jobs/producer:start] plan', { userId, projectId, sessionId: sessionIdForFilter || null, enc_ver: encVer, enc_fp: encFp, localDocker, sidecarEnabled });

    const gcpProject = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '';
    const location = process.env.CLOUD_RUN_LOCATION || process.env.REGION || 'us-central1';
    const producerSa = process.env.PRODUCER_JOB_SA_EMAIL || '';
    const consumerSa = process.env.CONSUMER_JOB_SA_EMAIL || '';

    if (!gcpProject) { await bestEffortRelease({ userId, projectId }); return { status: 500, body: { error: 'Server missing GCP project configuration' } }; }

    // Resolve Firebase and GitHub credentials using the shared cloud-consumer helper.
    const { githubToken, firebaseIdToken, firebaseCustomToken } = await loadConsumerCredentials({ userId, projectId });

    // Local Docker path
    if (localDocker) {
      const { status, body: bodyOut } = await startLocalDocker({
        userId,
        projectId,
        consumerId,
        gcpProject,
        gcsPrefix,
        baseCtx,
        encKeyB64,
        encVer,
        encFp,
        sessionIdForFilter,
        workspaceId,
        sidecarEnabled,
        sidecarImage,
        sidecarArgsTemplate,
        localDockerImage,
        localDockerArgs: body.localDockerArgs,
        githubToken,
        since_id,
        since_time,
        leaseMs,
        bestEffortRelease,
        firebaseIdToken,
        firebaseCustomToken,
        lockToken,
        lockId,
      });
      return { status: status, body: bodyOut };
    }

    // Determine platform: default to GKE
    const platform = (String(body.platform || process.env.PRODUCER_PLATFORM || 'gke') || 'gke').toLowerCase();

    // Cloud Run path (owns Pub/Sub: topic + req/resp subscriptions)
    if (platform === 'cloud-run') {
      const topic = requiredEnv('PUBSUB_TOPIC');

      const subSuffix = Math.random().toString(36).slice(2, 8);
      const baseId = sanitizeId(sessionIdForFilter ? `${projectId}-${sessionIdForFilter}` : `${projectId}`);
      const subReq = sanitizeId(`${topic}-req-${baseId}-${subSuffix}`, 220);
      const subResp = sanitizeId(`${topic}-resp-${baseId}-${subSuffix}`, 220);

      const filterBase = [
        `attributes.user_id = "${userId}"`,
        `attributes.project_id = "${projectId}"`,
        ...(sessionIdForFilter ? [`attributes.session_id = "${sessionIdForFilter}"`] : []),
      ].join(' AND ');

      const reqFilter = filterBase + ' AND attributes.channel = "req"';
      const respFilter = filterBase + ' AND attributes.channel = "resp"';

      const createdReq = await ensureSubscription({ gcpProject, name: subReq, topic, filter: reqFilter });
      if (!createdReq.ok) {
        await bestEffortRelease({ userId, projectId });
        return { status: 500, body: { error: 'Failed to create req subscription', details: createdReq.data || createdReq } };
      }
      const createdResp = await ensureSubscription({ gcpProject, name: subResp, topic, filter: respFilter });
      if (!createdResp.ok) {
        await deleteSubscription({ gcpProject, name: subReq }).catch(() => {});
        await bestEffortRelease({ userId, projectId });
        return { status: 500, body: { error: 'Failed to create resp subscription', details: createdResp.data || createdResp } };
      }

      try {
        if (consumerSa) await addSubscriberBinding({ gcpProject, subscription: subReq, saEmail: consumerSa });
        if (producerSa) await addSubscriberBinding({ gcpProject, subscription: subResp, saEmail: producerSa });
      } catch (e) {
        console.warn('[jobs/producer:start] IAM binding warning', e?.message || e);
      }

      const { status, body: bodyOut } = await startCloudRun({
        userId,
        projectId,
        consumerId,
        gcpProject,
        location,
        requestedConsumerImage,
        encKeyB64,
        encVer,
        encFp,
        baseCtx,
        gcsPrefix,
        sidecarEnabled,
        topic,
        subReq,
        subResp,
        sessionIdForFilter,
        githubToken,
        workspaceId,
        since_id,
        since_time,
        leaseMs,
        bestEffortRelease,
        // TODO: wire firebaseIdToken/customToken to Cloud Run consumer when supported
      });
      return { status: status, body: bodyOut };
    }

    // GKE path (default) — no Pub/Sub
    const { status, body: bodyOut } = await startGke({
      userId,
      projectId,
      consumerId,
      gcpProject,
      requestedConsumerImage,
      encKeyB64,
      encVer,
      encFp,
      baseCtx,
      gcsPrefix,
      sessionIdForFilter,
      githubToken,
      workspaceId,
      since_id,
      since_time,
      leaseMs,
      bestEffortRelease,
      firebaseIdToken,
      firebaseCustomToken,
      lockToken,
      lockId,
    });
    return { status: status, body: bodyOut };
  } catch (err) {
    console.error('[jobs/producer:start] error', err);
    try {
      const userId = userId;
      const projectId = projectId;
      if (userId && projectId && consumerId) {
        await releaseConsumerLock({ userId, projectId, consumerId });
      }
      // Best-effort: cancel/clear any scheduled progress
      if (userId && projectId) cancelStartupProgress({ userId: userId, projectId: projectId, reason: 'exception' });
    } catch {}
    return { status: 500, body: { error: String(err?.message || err) } };
  }
}

// Both the browser and MCP use this launcher; an existing project lock means
// we attach to the current consumer rather than creating another GKE Job.
export async function ensureProjectConsumer({ userId, projectId }, { getLock = getConsumerLock, start = startProjectConsumer } = {}) {
  const { lock } = await getLock({ userId, projectId });
  if (lock && lock.expiresAt > Date.now()) {
    return { state: 'attached', consumerId: lock.consumerId };
  }
  const result = await start({ userId, projectId });
  if (result.status === 202 && result.body?.message === 'Lock held by another consumer') {
    return { state: 'attached', consumerId: result.body.details?.holder?.consumerId };
  }
  if (result.status !== 202 || !result.body?.ok) {
    throw new Error(result.body?.error || 'Could not start project consumer');
  }
  return { state: 'starting', consumerId: result.body.consumerId };
}

