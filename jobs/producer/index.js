import express from 'express';
import {
  requiredEnv,
  randomId,
  splitArgs,
} from './utils.js';
import { runLocalDocker, stopContainer } from './docker.js';
import { ensureWorkspaceId } from '../../workflows/workspace/service.js';
import {
  acquireConsumerLock,
  releaseConsumerLock,
  setConsumerRuntimeInfo,
  getConsumerLock,
} from '../../workflows/projects/lock.js';
import { ensureSubscription, addSubscriberBinding, deleteSubscription } from './pubsubAdmin.js';
import { sanitizeId, buildBaseContext, deriveEncryption, buildProducerEnv } from './envBuilder.js';
import { launchLocalPair } from './localDocker.js';
import { runCloudRunJob, cancelOperation, cancelJobExecutions } from './cloudRun.js';
import { resolveStoredGithubToken } from '../../workflows/gitFiles.js';
import { scheduleStartupProgress, cancelStartupProgress, completeStartupProgress } from './progress.js';
import { monitorCloudRunStartup } from './readiness.js';

const router = express.Router();
router.use(express.json());

// POST /jobs/producer/start
router.post('/start', async (req, res) => {
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
    const userId = req.userId;
    const projectId = req.projectId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing user context' });
    if (!projectId) return res.status(400).json({ error: 'Missing x-project-id header' });

    const body = req.body || {};
    let workspaceId = String(body.workspaceId || body.workspace_id || '').trim();

    // Session handling:
    // - Use the provided sessionId (if any) for Pub/Sub filtering and runtime reporting.
    // - Do NOT default to a random session for workspace resolution; if absent, the workspace is project-wide.
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
        return res.status(400).json({ error: 'Failed to resolve/create workspace', details: String(e?.message || e) });
      }
    }

    const localDocker = Boolean(body.localDocker || process.env.PRODUCER_LOCAL_DOCKER);
    const localDockerImage = String(body.localDockerImage || process.env.PRODUCER_LOCAL_IMAGE || '').trim();

    const baseCtx = buildBaseContext({ body, localDocker });
    const { encKeyB64, encVer, encFp } = deriveEncryption({
      overrideKeyB64: body.ENC_KEY_B64 || body.enc_key_b64,
      overrideVer: body.ENC_VER || body.enc_ver,
    });

    consumerId = randomId('producer');

    const lock = await acquireConsumerLock({ userId, projectId, consumerId, leaseMs, consumerType: 'CLOUD' });
    if (!lock.ok && lock.conflict) {
      return res.status(202).json({ message: 'Lock held by another consumer', details: lock });
    }
    lockAcquired = true;

    const sidecarEnabled = String(process.env.PRODUCER_SIDECAR_ENABLE || '').trim() === '1';
    const sidecarImage = process.env.PRODUCER_SIDECAR_CONSUMER_IMAGE || 'awfl-consumer:dev';
    const sidecarArgsTemplate = process.env.PRODUCER_SIDECAR_DOCKER_ARGS || '';

    console.log('[jobs/producer:start] plan', { userId, projectId, sessionId: sessionIdForFilter || null, enc_ver: encVer, enc_fp: encFp, localDocker, sidecarEnabled });

    const gcpProject = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '';
    const location = process.env.CLOUD_RUN_LOCATION || process.env.REGION || 'us-central1';
    const topic = requiredEnv('PUBSUB_TOPIC');
    const producerSa = process.env.PRODUCER_JOB_SA_EMAIL || '';
    const consumerSa = process.env.CONSUMER_JOB_SA_EMAIL || '';

    if (!gcpProject) { await bestEffortRelease({ userId, projectId }); return res.status(500).json({ error: 'Server missing GCP project configuration' }); }

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
      return res.status(500).json({ error: 'Failed to create req subscription', details: createdReq.data || createdReq });
    }
    const createdResp = await ensureSubscription({ gcpProject, name: subResp, topic, filter: respFilter });
    if (!createdResp.ok) {
      await deleteSubscription({ gcpProject, name: subReq }).catch(() => {});
      await bestEffortRelease({ userId, projectId });
      return res.status(500).json({ error: 'Failed to create resp subscription', details: createdResp.data || createdResp });
    }

    try {
      if (consumerSa) await addSubscriberBinding({ gcpProject, subscription: subReq, saEmail: consumerSa });
      if (producerSa) await addSubscriberBinding({ gcpProject, subscription: subResp, saEmail: producerSa });
    } catch (e) {
      console.warn('[jobs/producer:start] IAM binding warning', e?.message || e);
    }

    // Resolve any stored GitHub token (Firestore-backed) so the consumer can perform git ops.
    // IMPORTANT: never log the token.
    let githubToken = null;
    try {
      githubToken = await resolveStoredGithubToken({ userId, projectId });
    } catch {
      githubToken = null;
    }

    if (localDocker) {
      const image = localDockerImage || 'awfl-producer:dev';
      const producerContainerName = `producer-${consumerId}`.slice(0, 63);
      const producerEnvPairs = buildProducerEnv({
        userId,
        projectId,
        workspaceId,
        sessionId: sessionIdForFilter || undefined,
        since_id,
        since_time,
        workflowsBaseUrl: baseCtx.workflowsBaseUrl,
        workflowsAudience: baseCtx.workflowsAudience,
        serviceAuthToken: baseCtx.serviceAuthToken,
        leaseMs,
        encKeyB64,
        encVer,
        eventsHeartbeatMs: baseCtx.eventsHeartbeatMs,
        reconnectBackoffMs: baseCtx.reconnectBackoffMs,
        consumerId,
      });

      producerEnvPairs.push({ name: 'PUBSUB_ENABLE', value: '1' });
      producerEnvPairs.push({ name: 'TOPIC', value: topic });
      producerEnvPairs.push({ name: 'SUBSCRIPTION', value: subResp });

      try {
        let sidecarInfo = null;
        let sidecarName = null;

        if (sidecarEnabled) {
          sidecarName = `consumer-${consumerId}`.slice(0, 63);

          // Schedule startup progress BEFORE launching containers so the overlay reflects actual startup.
          const sched = scheduleStartupProgress({ userId, projectId });
          if (!sched?.ok) console.warn('[jobs/producer:start] progress schedule failed', sched);
          else console.log('[jobs/producer:start] progress scheduled', { userId, projectId });

          const { producerInfo, consumerInfo } = await launchLocalPair({
            producerImage: image,
            producerContainerName,
            producerEnvPairs,
            producerExtraArgs: Array.isArray(body.localDockerArgs) ? body.localDockerArgs : splitArgs(body.localDockerArgs || ''),
            consumerImage: sidecarImage,
            consumerContainerName: sidecarName,
            consumerArgsTemplate: sidecarArgsTemplate,
            workflowsBaseUrl: baseCtx.workflowsBaseUrl,
            eventsHeartbeatMs: baseCtx.eventsHeartbeatMs,
            reconnectBackoffMs: baseCtx.reconnectBackoffMs,
            encKeyB64,
            encVer,
            topic,
            subReq,
            // Pass through stored token (if any)
            githubToken,
          });
          sidecarInfo = consumerInfo;
          try {
            await setConsumerRuntimeInfo({
              userId,
              projectId,
              consumerId,
              runtime: {
                mode: 'local-docker',
                producer: { containerName: producerContainerName, containerId: producerInfo?.id || null },
                sidecar: sidecarName ? { containerName: sidecarName, containerId: sidecarInfo?.id || null } : null,
                stopRequested: false,
                enc_ver: encVer,
                enc_fp: encFp,
                sessionId: sessionIdForFilter || null,
                sub_req: subReq,
                sub_resp: subResp,
                topic,
              },
            });
          } catch (e) {
            console.warn('[jobs/producer:start] failed to persist runtime info', e?.message || e);
          }

          // Both containers are launched; clear the startup overlay immediately.
          try { completeStartupProgress({ userId, projectId, reason: 'local-docker started' }); } catch (e) { console.warn('[jobs/producer:start] progress early-complete failed', e?.message || e); }

          return res.status(202).json({ ok: true, mode: 'local-docker', image, containerName: producerContainerName, containerId: (producerInfo?.id || null), consumerId, workspaceId, sessionId: sessionIdForFilter || null, enc_ver: encVer, enc_fp: encFp, sub_req: subReq, sub_resp: subResp, topic });
        }

        const { id, args } = await runLocalDocker({ image, containerName: producerContainerName, envPairs: producerEnvPairs, extraArgs: Array.isArray(body.localDockerArgs) ? body.localDockerArgs : splitArgs(body.localDockerArgs || '') });

        try {
          await setConsumerRuntimeInfo({
            userId,
            projectId,
            consumerId,
            runtime: {
              mode: 'local-docker',
              producer: { containerName: producerContainerName, containerId: id },
              sidecar: null,
              stopRequested: false,
              enc_ver: encVer,
              enc_fp: encFp,
              sessionId: sessionIdForFilter || null,
              sub_req: subReq,
              sub_resp: subResp,
              topic,
            },
          });
        } catch (e) {
          console.warn('[jobs/producer:start] failed to persist runtime info', e?.message || e);
        }

        // No sidecar/consumer -> skip progress overlay
        return res.status(202).json({ ok: true, mode: 'local-docker', image, containerName: producerContainerName, containerId: id, consumerId, args, workspaceId, sessionId: sessionIdForFilter || null, enc_ver: encVer, enc_fp: encFp, sub_req: subReq, sub_resp: subResp, topic });
      } catch (e) {
        console.error('[jobs/producer:start] local docker error', e);
        await deleteSubscription({ gcpProject, name: subReq }).catch(() => {});
        await deleteSubscription({ gcpProject, name: subResp }).catch(() => {});
        await bestEffortRelease({ userId, projectId });
        // On error, ensure any scheduled progress is cancelled/cleared (best-effort)
        cancelStartupProgress({ userId, projectId, reason: 'local-docker error' });
        return res.status(500).json({ error: 'Failed to start local docker container', details: String(e?.message || e) });
      }
    }

    const consumerJobName = process.env.CONSUMER_CLOUD_RUN_JOB_NAME || '';
    const producerJobName = process.env.PRODUCER_CLOUD_RUN_JOB_NAME || process.env.CLOUD_RUN_JOB_NAME;
    const producerContainerName = process.env.PRODUCER_CONTAINER_NAME || process.env.CLOUD_RUN_CONTAINER_NAME || 'producer';

    if (!producerJobName) { await bestEffortRelease({ userId, projectId }); return res.status(500).json({ error: 'Server missing PRODUCER_CLOUD_RUN_JOB_NAME' }); }
    if (!consumerJobName) { await bestEffortRelease({ userId, projectId }); return res.status(500).json({ error: 'Server missing CONSUMER_CLOUD_RUN_JOB_NAME' }); }

    // Build overrides up front so both jobs can be started in parallel
    const consumerOverrides = [{
      name: 'consumer',
      env: [
        { name: 'SUBSCRIPTION', value: subReq },
        { name: 'ENC_KEY_B64', value: encKeyB64 },
        { name: 'ENC_VER', value: encVer },
        { name: 'REPLY_CHANNEL', value: 'resp' },
        { name: 'GCS_DEBUG', value: '1' },
        { name: 'GCS_TRACE', value: '1' },
        { name: 'CONSUMER_ID', value: consumerId },
        ...(githubToken ? [{ name: 'GITHUB_TOKEN', value: githubToken }] : []),
      ],
    }];

    const producerEnvPairs = buildProducerEnv({
      userId,
      projectId,
      workspaceId,
      sessionId: sessionIdForFilter || undefined,
      since_id,
      since_time,
      workflowsBaseUrl: baseCtx.workflowsBaseUrl,
      workflowsAudience: baseCtx.workflowsAudience,
      serviceAuthToken: baseCtx.serviceAuthToken,
      leaseMs,
      encKeyB64,
      encVer,
      eventsHeartbeatMs: baseCtx.eventsHeartbeatMs,
      reconnectBackoffMs: baseCtx.reconnectBackoffMs,
      consumerId,
    });

    const producerOverrides = [{ name: producerContainerName, env: [...producerEnvPairs, { name: 'SUBSCRIPTION', value: subResp }] }];

    // Start both Cloud Run Jobs in parallel; handle failures with unified cleanup/cancellation
    let consumerRun, producerRun;
    try {
      [consumerRun, producerRun] = await Promise.all([
        runCloudRunJob({ gcpProject, location, jobName: consumerJobName, containerOverrides: consumerOverrides }),
        runCloudRunJob({ gcpProject, location, jobName: producerJobName, containerOverrides: producerOverrides }),
      ]);
    } catch (e) {
      // Transport/runtime fault starting one of the jobs
      await deleteSubscription({ gcpProject, name: subReq }).catch(() => {});
      await deleteSubscription({ gcpProject, name: subResp }).catch(() => {});
      await bestEffortRelease({ userId, projectId });
      // Best-effort clear/cancel any progress schedule
      cancelStartupProgress({ userId, projectId, reason: 'cloud-run launch transport error' });
      return res.status(500).json({ error: 'Transport error starting Cloud Run jobs', details: String(e?.message || e) });
    }

    if (!consumerRun?.ok || !producerRun?.ok) {
      // Attempt to cancel any job that did start
      const cancelOps = [];
      try {
        if (consumerRun?.ok && consumerRun?.data?.name) cancelOps.push(cancelOperation({ name: consumerRun.data.name }).catch(() => ({ ok: false })));
        if (producerRun?.ok && producerRun?.data?.name) cancelOps.push(cancelOperation({ name: producerRun.data.name }).catch(() => ({ ok: false })));
        await Promise.allSettled(cancelOps);
      } catch {}

      await deleteSubscription({ gcpProject, name: subReq }).catch(() => {});
      await deleteSubscription({ gcpProject, name: subResp }).catch(() => {});
      await bestEffortRelease({ userId, projectId });

      const status = (!consumerRun?.ok ? consumerRun?.status : null) || (!producerRun?.ok ? producerRun?.status : null) || 500;
      // Best-effort clear/cancel any progress schedule
      cancelStartupProgress({ userId, projectId, reason: 'cloud-run start failed' });
      return res.status(status).json({
        error: 'Failed to start jobs',
        consumer: consumerRun,
        producer: producerRun,
      });
    }

    try {
      await setConsumerRuntimeInfo({
        userId,
        projectId,
        consumerId,
        runtime: {
          mode: 'cloud-run',
          jobName: producerJobName,
          consumerJobName,
          location,
          operation: producerRun.data.name || null,
          consumerOperation: consumerRun.data.name || null,
          sidecarEnabled,
          stopRequested: false,
          enc_ver: encVer,
          enc_fp: encFp,
          sessionId: sessionIdForFilter || null,
          sub_req: subReq,
          sub_resp: subResp,
          topic,
        },
      });
    } catch (e) {
      console.warn('[jobs/producer:start] failed to persist cloud-run runtime info', e?.message || e);
    }

    // Schedule user-visible startup progress messages (~80s)
    const sched = scheduleStartupProgress({ userId, projectId });
    if (!sched?.ok) console.warn('[jobs/producer:start] progress schedule failed', sched);
    else console.log('[jobs/producer:start] progress scheduled', { userId, projectId });

    // Fire-and-forget readiness monitor that clears as soon as both jobs have started
    try {
      void monitorCloudRunStartup({
        userId,
        projectId,
        producerOperationName: producerRun.data.name || null,
        consumerOperationName: consumerRun.data.name || null,
        timeoutMs: 90_000,
      });
    } catch (e) {
      console.warn('[jobs/producer:start] readiness monitor failed to start', e?.message || e);
    }

    return res.status(202).json({ ok: true, mode: 'cloud-run', producerJob: producerJobName, consumerJob: consumerJobName, location, operation: producerRun.data.name || null, consumerOperation: consumerRun.data.name || null, consumerId, lock: lock.lock || null, workspaceId, sidecarEnabled, sessionId: sessionIdForFilter || null, enc_ver: encVer, enc_fp: encFp, sub_req: subReq, sub_resp: subResp, topic });
  } catch (err) {
    console.error('[jobs/producer:start] error', err);
    try {
      const userId = req.userId;
      const projectId = req.projectId;
      if (userId && projectId && consumerId) {
        await releaseConsumerLock({ userId, projectId, consumerId });
      }
      // Best-effort: cancel/clear any scheduled progress
      if (req.userId && req.projectId) cancelStartupProgress({ userId: req.userId, projectId: req.projectId, reason: 'exception' });
    } catch {}
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

// POST /jobs/producer/stop
router.post('/stop', async (req, res) => {
  try {
    const userId = req.userId;
    const projectId = req.projectId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing user context' });
    if (!projectId) return res.status(400).json({ error: 'Missing x-project-id header' });

    // Cancel any in-progress startup overlay immediately
    try { cancelStartupProgress({ userId, projectId, reason: 'stop requested' }); } catch {}

    const { ok, lock } = await getConsumerLock({ userId, projectId });
    if (!ok) return res.status(500).json({ error: 'Failed to read lock' });
    if (!lock) return res.status(200).json({ ok: true, message: 'No active lock' });

    const runtime = lock.runtime || null;
    const results = {};

    const gcpProject = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '';

    if (runtime?.mode === 'local-docker') {
      try {
        if (runtime?.sub_req) await deleteSubscription({ gcpProject, name: runtime.sub_req });
        if (runtime?.sub_resp) await deleteSubscription({ gcpProject, name: runtime.sub_resp });
      } catch {}

      const prodName = runtime?.producer?.containerName || runtime?.producer?.containerId;
      const sideName = runtime?.sidecar?.containerName || runtime?.sidecar?.containerId;
      if (prodName) {
        try { await stopContainer(prodName); results.producer = 'stopped'; } catch { results.producer = 'error'; }
      }
      if (sideName) {
        try { await stopContainer(sideName); results.sidecar = 'stopped'; } catch { results.sidecar = 'error'; }
      }
      const rel = await releaseConsumerLock({ userId, projectId, force: true });
      return res.status(200).json({ ok: true, mode: 'local-docker', results, released: rel?.released !== false });
    }

    if (runtime?.mode === 'cloud-run') {
      try {
        if (runtime?.sub_req) await deleteSubscription({ gcpProject, name: runtime.sub_req });
        if (runtime?.sub_resp) await deleteSubscription({ gcpProject, name: runtime.sub_resp });
      } catch {}

      // Attempt to cancel current operations and any running executions for both producer and consumer jobs
      const location = runtime?.location || process.env.CLOUD_RUN_LOCATION || process.env.REGION || 'us-central1';
      const cancelOps = [];
      if (runtime?.operation) cancelOps.push(cancelOperation({ name: runtime.operation }).catch(() => ({ ok: false })));
      if (runtime?.consumerOperation) cancelOps.push(cancelOperation({ name: runtime.consumerOperation }).catch(() => ({ ok: false })));
      const jobCancels = [];
      if (runtime?.jobName) jobCancels.push(cancelJobExecutions({ gcpProject, location, jobName: runtime.jobName }).catch(() => ({ ok: false })));
      if (runtime?.consumerJobName) jobCancels.push(cancelJobExecutions({ gcpProject, location, jobName: runtime.consumerJobName }).catch(() => ({ ok: false })));
      try {
        const [opRes, jobRes] = await Promise.allSettled([
          Promise.all(cancelOps),
          Promise.all(jobCancels),
        ]);
        results.operations = opRes.status === 'fulfilled' ? opRes.value : [];
        results.jobCancels = jobRes.status === 'fulfilled' ? jobRes.value : [];
      } catch {}

      try {
        await setConsumerRuntimeInfo({ userId, projectId, consumerId: lock.consumerId, runtime: { ...runtime, stopRequested: true, stopAt: Date.now() } });
      } catch {}
      const rel = await releaseConsumerLock({ userId, projectId, force: true });
      return res.status(200).json({ ok: true, mode: 'cloud-run', message: 'Stop requested. Jobs cancellation attempted. Lock released. Subscriptions deleted (best-effort).', results, released: rel?.released !== false });
    }

    const rel = await releaseConsumerLock({ userId, projectId, force: true });
    return res.status(200).json({ ok: true, mode: runtime?.mode || 'unknown', message: 'Lock released', released: rel?.released !== false });
  } catch (err) {
    console.error('[jobs/producer:stop] error', err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

export default router;
