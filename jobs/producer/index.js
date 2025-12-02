import express from 'express';
import {
  requiredEnv,
  getAccessToken,
  rewriteLocalhostForDocker,
  randomId,
  splitArgs,
  applyTemplate,
} from './utils.js';
import { runLocalDocker, stopContainer } from './docker.js';
import { startExitMonitor } from './monitor.js';
import { ensureWorkspaceId } from '../../workflows/workspace/service.js';
import {
  acquireConsumerLock,
  releaseConsumerLock,
  setConsumerRuntimeInfo,
  getConsumerLock,
} from '../../workflows/projects/lock.js';

// NOTE: Canonical producer runtime is cloud/producer/app/runner.js.
// This route primarily triggers a Cloud Run Job execution and passes context/env.
// In local dev, it can alternatively start a Docker container (Docker Desktop) running the same runner.
// Keep logic here minimal to avoid drift.

const router = express.Router();
router.use(express.json());

// POST /jobs/producer/start — trigger a Cloud Run Job execution for the producer bridge
// Body: {
//   sessionId?, since_id?, since_time?, leaseMs?, eventsHeartbeatMs?, reconnectBackoffMs?,
//   localDocker?, localDockerImage?, localDockerArgs?, workspaceTtlMs?
// }
// - workspaceId is optional; if missing, resolve/create using workflows/workspace logic
// Requires headers injected by jobs service: req.userId, req.projectId
router.post('/start', async (req, res) => {
  let consumerId = null;
  let lockAcquired = false;
  const bestEffortRelease = async (ctx = {}) => {
    try {
      if (lockAcquired && consumerId) {
        await releaseConsumerLock({ userId: ctx.userId, projectId: ctx.projectId, consumerId });
      }
    } catch {
      // ignore best-effort release errors
    }
  };

  try {
    const userId = req.userId;
    const projectId = req.projectId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing user context' });
    if (!projectId) return res.status(400).json({ error: 'Missing x-project-id header' });

    const body = req.body || {};
    let workspaceId = String(body.workspaceId || body.workspace_id || '').trim();
    const sessionId = String(body.sessionId || body.session_id || '').trim();
    const since_id = String(body.since_id || '').trim();
    const since_time = String(body.since_time || '').trim();
    const leaseMs = Number.isFinite(Number(body.leaseMs)) ? Math.max(5000, Math.min(10 * 60 * 1000, Number(body.leaseMs))) : 10 * 60 * 1000;
    const workspaceTtlMs = Number.isFinite(Number(body.workspaceTtlMs)) ? Number(body.workspaceTtlMs) : undefined;

    // Optional runtime tunables
    const eventsHeartbeatMs = Number.isFinite(Number(body.eventsHeartbeatMs)) ? String(Number(body.eventsHeartbeatMs)) : (process.env.EVENTS_HEARTBEAT_MS || '');
    const reconnectBackoffMs = Number.isFinite(Number(body.reconnectBackoffMs)) ? String(Number(body.reconnectBackoffMs)) : (process.env.RECONNECT_BACKOFF_MS || '');

    // Auto-resolve/create workspace if not provided
    if (!workspaceId) {
      try {
        workspaceId = await ensureWorkspaceId({ userId, projectId, sessionId: sessionId || undefined, ttlMs: workspaceTtlMs });
      } catch (e) {
        return res.status(400).json({ error: 'Failed to resolve/create workspace', details: String(e?.message || e) });
      }
    }

    // Compose env overrides for runner (both Cloud Run job and local docker use these)
    const baseWorkflowsUrl = requiredEnv('WORKFLOWS_BASE_URL');
    const workflowsAudience = process.env.WORKFLOWS_AUDIENCE || baseWorkflowsUrl;
    const serviceAuthToken = process.env.SERVICE_AUTH_TOKEN || '';

    consumerId = randomId('producer');

    // Acquire project consumer lock before triggering runner (use in-process util)
    const lock = await acquireConsumerLock({ userId, projectId, consumerId, leaseMs, consumerType: 'CLOUD' });
    if (!lock.ok && lock.conflict) {
      return res.status(202).json({ message: 'Lock held by another consumer', details: lock });
    }
    lockAcquired = true;

    // Determine if we should run locally via Docker Desktop
    const localDocker = Boolean(body.localDocker || process.env.PRODUCER_LOCAL_DOCKER);
    const localDockerImage = String(body.localDockerImage || process.env.PRODUCER_LOCAL_IMAGE || '').trim();

    // Shared env for runner
    // In local docker mode, we rewrite localhost URLs to host.docker.internal for container reachability
    const workflowsBaseUrl = localDocker ? rewriteLocalhostForDocker(baseWorkflowsUrl) : baseWorkflowsUrl;

    // Sidecar settings (enabled for both local docker and cloud run when flag is set)
    const sidecarEnabled = String(process.env.PRODUCER_SIDECAR_ENABLE || '').trim() === '1';
    const sidecarImage = process.env.PRODUCER_SIDECAR_CONSUMER_IMAGE || 'awfl-consumer:dev';
    const sidecarPort = Number(process.env.PRODUCER_SIDECAR_CONSUMER_PORT || 8080);
    const sidecarWorkPrefixTemplate = process.env.PRODUCER_SIDECAR_WORK_PREFIX_TEMPLATE || '';
    const sidecarContainerName = process.env.PRODUCER_SIDECAR_CONTAINER_NAME || 'consumer';

    // Producer default target (may be overridden by sidecar)
    let consumerBaseUrl = '';

    // Prepare base env pairs (shared) for producer
    const envPairs = [
      { name: 'X_USER_ID', value: userId },
      { name: 'X_PROJECT_ID', value: projectId },
      ...(workspaceId ? [{ name: 'X_WORKSPACE_ID', value: workspaceId }] : []),
      ...(sessionId ? [{ name: 'X_SESSION_ID', value: sessionId }] : []),
      ...(since_id ? [{ name: 'SINCE_ID', value: since_id }] : []),
      ...(since_time ? [{ name: 'SINCE_TIME', value: since_time }] : []),
      { name: 'WORKFLOWS_BASE_URL', value: workflowsBaseUrl },
      { name: 'WORKFLOWS_AUDIENCE', value: workflowsAudience },
      ...(serviceAuthToken ? [{ name: 'SERVICE_AUTH_TOKEN', value: serviceAuthToken }] : []),
      ...(eventsHeartbeatMs ? [{ name: 'EVENTS_HEARTBEAT_MS', value: eventsHeartbeatMs }] : []),
      ...(reconnectBackoffMs ? [{ name: 'RECONNECT_BACKOFF_MS', value: reconnectBackoffMs }] : []),
      // Useful context for logs
      { name: 'CONSUMER_ID', value: consumerId },
      { name: 'GCS_BUCKET', value: process.env.GCS_BUCKET },
      { name: 'GCS_DEBUG', value: '1' },
      // Ensure runner uses the same lock lease the server acquired
      { name: 'LOCK_LEASE_MS', value: String(leaseMs) },
    ];

    // Prepare sidecar env (used in both local and cloud-run when enabled)
    const sidecarEnv = [
      { name: 'PORT', value: String(sidecarPort) },
      { name: 'WORKFLOWS_BASE_URL', value: workflowsBaseUrl },
      ...(eventsHeartbeatMs ? [{ name: 'EVENTS_HEARTBEAT_MS', value: eventsHeartbeatMs }] : []),
      ...(reconnectBackoffMs ? [{ name: 'RECONNECT_BACKOFF_MS', value: reconnectBackoffMs }] : []),
      ...(sidecarWorkPrefixTemplate ? [{ name: 'WORK_PREFIX_TEMPLATE', value: sidecarWorkPrefixTemplate }] : []),
      { name: 'GCS_BUCKET', value: process.env.GCS_BUCKET },
      { name: 'GCS_DEBUG', value: '1' }
    ];

    let sidecarInfo = null;
    let sidecarName = null;

    if (localDocker && sidecarEnabled) {
      // Launch the dedicated consumer sidecar first
      sidecarName = `sse-consumer-${consumerId}`.slice(0, 63);

      const sidecarArgsTemplate = process.env.PRODUCER_SIDECAR_DOCKER_ARGS || '';
      const renderedArgs = applyTemplate(sidecarArgsTemplate, { userId, projectId, workspaceId, sessionId });
      const sidecarExtraArgs = [
        '--label', 'awfl.role=sse-consumer-sidecar',
        '--label', `awfl.session=${sessionId || ''}`,
        '--label', `awfl.project=${projectId}`,
        '--label', `awfl.workspace=${workspaceId || ''}`,
        ...splitArgs(renderedArgs),
      ];

      try {
        sidecarInfo = await runLocalDocker({ image: sidecarImage, containerName: sidecarName, envPairs: sidecarEnv, extraArgs: sidecarExtraArgs });
      } catch (e) {
        console.error('[jobs/producer:start] failed to launch sidecar consumer', e);
        await bestEffortRelease({ userId, projectId });
        return res.status(500).json({ error: 'Failed to start sidecar consumer', details: String(e?.message || e) });
      }

      // Point producer at its sidecar using Docker DNS (container name)
      consumerBaseUrl = `http://${sidecarName}:${sidecarPort}`;

      // Update envPairs entry for CONSUMER_BASE_URL
      const idx = envPairs.findIndex((e) => e.name === 'CONSUMER_BASE_URL');
      if (idx >= 0) envPairs[idx] = { name: 'CONSUMER_BASE_URL', value: consumerBaseUrl };
      else envPairs.push({ name: 'CONSUMER_BASE_URL', value: consumerBaseUrl });
    }

    // For Cloud Run jobs with a sidecar, producer should talk to localhost:sidecarPort
    if (!localDocker && sidecarEnabled) {
      consumerBaseUrl = `http://localhost:${sidecarPort}`;
      const idx = envPairs.findIndex((e) => e.name === 'CONSUMER_BASE_URL');
      if (idx >= 0) envPairs[idx] = { name: 'CONSUMER_BASE_URL', value: consumerBaseUrl };
      else envPairs.push({ name: 'CONSUMER_BASE_URL', value: consumerBaseUrl });
    }

    if (localDocker) {
      const image = localDockerImage || 'awfl-producer:dev';
      const containerName = `producer-${consumerId}`.slice(0, 63); // docker name length limit
      const extraArgs = Array.isArray(body.localDockerArgs) ? body.localDockerArgs : splitArgs(body.localDockerArgs || '');

      try {
        const { id, args } = await runLocalDocker({ image, containerName, envPairs, extraArgs });

        // Persist runtime info so /stop can target the right instances
        try {
          await setConsumerRuntimeInfo({
            userId,
            projectId,
            consumerId,
            runtime: {
              mode: 'local-docker',
              producer: { containerName, containerId: id },
              sidecar: sidecarName ? { containerName: sidecarName, containerId: sidecarInfo?.id || null, port: sidecarPort } : null,
              stopRequested: false,
            },
          });
        } catch (e) {
          console.warn('[jobs/producer:start] failed to persist runtime info', e?.message || e);
        }

        // Start a background monitor that waits for the producer container to exit.
        // When it does, stop the sidecar consumer (if any) and release the project consumer lock.
        startExitMonitor({ producerKey: containerName || id, sidecarName, userId, projectId, consumerId });

        return res.status(202).json({ ok: true, mode: 'local-docker', image, containerName, containerId: id, consumerId, args, lock: lock.lock || null, sidecar: sidecarInfo, workspaceId });
      } catch (e) {
        console.error('[jobs/producer:start] local docker error', e);
        // Attempt cleanup of sidecar if we started one
        if (sidecarName) await stopContainer(sidecarName);
        await bestEffortRelease({ userId, projectId });
        return res.status(500).json({ error: 'Failed to start local docker container', details: String(e?.message || e) });
      }
    }

    // Otherwise, trigger Cloud Run Job
    const gcpProject = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '';
    const location = process.env.CLOUD_RUN_LOCATION || process.env.REGION || 'us-central1';
    const jobName = process.env.PRODUCER_CLOUD_RUN_JOB_NAME || process.env.CLOUD_RUN_JOB_NAME;
    const producerContainerName = process.env.PRODUCER_CONTAINER_NAME || process.env.CLOUD_RUN_CONTAINER_NAME || 'producer';

    if (!gcpProject) { await bestEffortRelease({ userId, projectId }); return res.status(500).json({ error: 'Server missing GCP project configuration' }); }
    if (!jobName) { await bestEffortRelease({ userId, projectId }); return res.status(500).json({ error: 'Server missing PRODUCER_CLOUD_RUN_JOB_NAME' }); }

    const url = `https://run.googleapis.com/v2/projects/${encodeURIComponent(gcpProject)}/locations/${encodeURIComponent(location)}/jobs/${encodeURIComponent(jobName)}:run`;
    const token = await getAccessToken();

    // v2 RunJobRequest supports overrides.containerOverrides[].env
    const containerOverrides = [
      { name: producerContainerName, env: envPairs },
      // If the Job template defines a sidecar container with this name, apply env overrides to it as well
      ...(sidecarEnabled ? [{ name: sidecarContainerName, env: sidecarEnv }] : []),
    ];

    const payload = { overrides: { containerOverrides } };

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      await bestEffortRelease({ userId, projectId });
      return res.status(resp.status).json({ error: 'Failed to start job', details: data });
    }

    // Persist runtime info for cloud-run
    try {
      await setConsumerRuntimeInfo({
        userId,
        projectId,
        consumerId,
        runtime: {
          mode: 'cloud-run',
          jobName,
          location,
          operation: data.name || null,
          sidecarEnabled,
          stopRequested: false,
        },
      });
    } catch (e) {
      console.warn('[jobs/producer:start] failed to persist cloud-run runtime info', e?.message || e);
    }

    return res.status(202).json({ ok: true, mode: 'cloud-run', job: jobName, location, operation: data.name || null, consumerId, lock: lock.lock || null, workspaceId, sidecarEnabled });
  } catch (err) {
    console.error('[jobs/producer:start] error', err);
    // best-effort release on unexpected error
    try {
      const userId = req.userId;
      const projectId = req.projectId;
      if (userId && projectId && consumerId) {
        await releaseConsumerLock({ userId, projectId, consumerId });
      }
    } catch {}
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

// POST /jobs/producer/stop — stop producer/consumer for the locked project
// Body: { }
router.post('/stop', async (req, res) => {
  try {
    const userId = req.userId;
    const projectId = req.projectId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing user context' });
    if (!projectId) return res.status(400).json({ error: 'Missing x-project-id header' });

    const { ok, lock } = await getConsumerLock({ userId, projectId });
    if (!ok) return res.status(500).json({ error: 'Failed to read lock' });
    if (!lock) return res.status(200).json({ ok: true, message: 'No active lock' });

    const runtime = lock.runtime || null;
    const results = {};

    if (runtime?.mode === 'local-docker') {
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
      // Placeholder: mark stopRequested and force-release lock. Future: cancel operation or signal consumer service.
      try {
        await setConsumerRuntimeInfo({ userId, projectId, consumerId: lock.consumerId, runtime: { ...runtime, stopRequested: true, stopAt: Date.now() } });
      } catch {}
      const rel = await releaseConsumerLock({ userId, projectId, force: true });
      return res.status(200).json({ ok: true, mode: 'cloud-run', message: 'Stop requested (placeholder). Lock released.', released: rel?.released !== false });
    }

    // Unknown mode: just force-release the lock
    const rel = await releaseConsumerLock({ userId, projectId, force: true });
    return res.status(200).json({ ok: true, mode: runtime?.mode || 'unknown', message: 'Lock released', released: rel?.released !== false });
  } catch (err) {
    console.error('[jobs/producer:stop] error', err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

export default router;
