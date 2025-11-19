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
import { ensureWorkspaceId } from '../../workflows/workspace/service.js';
import { acquireConsumerLock, releaseConsumerLock } from '../../workflows/projects/lock.js';

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
    } catch (_e) {
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
    // const baseConsumerUrl = requiredEnv('CONSUMER_BASE_URL');
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

    // Sidecar settings (local docker only)
    const sidecarEnabled = localDocker && String(process.env.PRODUCER_SIDECAR_ENABLE || '').trim() === '1';
    const sidecarImage = process.env.PRODUCER_SIDECAR_CONSUMER_IMAGE || 'awfl-consumer:dev';
    const sidecarPort = Number(process.env.PRODUCER_SIDECAR_CONSUMER_PORT || 8080);
    const sidecarWorkPrefixTemplate = process.env.PRODUCER_SIDECAR_WORK_PREFIX_TEMPLATE || '';

    // Producer default target (may be overridden by sidecar)
    let consumerBaseUrl = '';
    // let consumerBaseUrl = localDocker ? rewriteLocalhostForDocker(baseConsumerUrl) : baseConsumerUrl;

    // Prepare base env pairs (shared)
    const envPairs = [
      { name: 'X_USER_ID', value: userId },
      { name: 'X_PROJECT_ID', value: projectId },
      ...(workspaceId ? [{ name: 'X_WORKSPACE_ID', value: workspaceId }] : []),
      ...(sessionId ? [{ name: 'X_SESSION_ID', value: sessionId }] : []),
      ...(since_id ? [{ name: 'SINCE_ID', value: since_id }] : []),
      ...(since_time ? [{ name: 'SINCE_TIME', value: since_time }] : []),
      { name: 'WORKFLOWS_BASE_URL', value: workflowsBaseUrl },
      { name: 'WORKFLOWS_AUDIENCE', value: workflowsAudience },
      // // CONSUMER_BASE_URL may be overridden below if sidecar is launched
      // { name: 'CONSUMER_BASE_URL', value: consumerBaseUrl },
      ...(serviceAuthToken ? [{ name: 'SERVICE_AUTH_TOKEN', value: serviceAuthToken }] : []),
      ...(eventsHeartbeatMs ? [{ name: 'EVENTS_HEARTBEAT_MS', value: eventsHeartbeatMs }] : []),
      ...(reconnectBackoffMs ? [{ name: 'RECONNECT_BACKOFF_MS', value: reconnectBackoffMs }] : []),
      // Useful context for logs
      { name: 'CONSUMER_ID', value: consumerId },
      { name: 'GCS_BUCKET', value: process.env.GCS_BUCKET },
      { name: 'GCS_DEBUG', value: '1' }
    ];

    let sidecarInfo = null;
    let sidecarName = null;

    if (sidecarEnabled) {
      // Launch the dedicated consumer sidecar first
      sidecarName = `sse-consumer-${consumerId}`.slice(0, 63);

      const sidecarEnv = [
        { name: 'PORT', value: String(sidecarPort) },
        { name: 'WORKFLOWS_BASE_URL', value: workflowsBaseUrl },
        ...(eventsHeartbeatMs ? [{ name: 'EVENTS_HEARTBEAT_MS', value: eventsHeartbeatMs }] : []),
        ...(reconnectBackoffMs ? [{ name: 'RECONNECT_BACKOFF_MS', value: reconnectBackoffMs }] : []),
        ...(sidecarWorkPrefixTemplate ? [{ name: 'WORK_PREFIX_TEMPLATE', value: sidecarWorkPrefixTemplate }] : []),
        { name: 'GCS_BUCKET', value: process.env.GCS_BUCKET }
        // No SERVICE_AUTH_TOKEN in dev sidecar; prod uses OIDC on Cloud Run
      ];

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

    if (localDocker) {
      const image = localDockerImage || 'awfl-producer:dev';
      const containerName = `producer-${consumerId}`.slice(0, 63); // docker name length limit
      const extraArgs = Array.isArray(body.localDockerArgs) ? body.localDockerArgs : splitArgs(body.localDockerArgs || '');

      try {
        const { id, args } = await runLocalDocker({ image, containerName, envPairs, extraArgs });
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
    const containerName = process.env.PRODUCER_CONTAINER_NAME || process.env.CLOUD_RUN_CONTAINER_NAME || 'producer';

    if (!gcpProject) { await bestEffortRelease({ userId, projectId }); return res.status(500).json({ error: 'Server missing GCP project configuration' }); }
    if (!jobName) { await bestEffortRelease({ userId, projectId }); return res.status(500).json({ error: 'Server missing PRODUCER_CLOUD_RUN_JOB_NAME' }); }

    const url = `https://run.googleapis.com/v2/projects/${encodeURIComponent(gcpProject)}/locations/${encodeURIComponent(location)}/jobs/${encodeURIComponent(jobName)}:run`;
    const token = await getAccessToken();

    // v2 RunJobRequest supports overrides.containerOverrides[].env
    const payload = {
      overrides: {
        containerOverrides: [
          {
            name: containerName,
            env: envPairs,
          },
        ],
      },
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      await bestEffortRelease({ userId, projectId });
      return res.status(resp.status).json({ error: 'Failed to start job', details: data });
    }

    return res.status(202).json({ ok: true, mode: 'cloud-run', job: jobName, location, operation: data.name || null, consumerId, lock: lock.lock || null, workspaceId });
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

export default router;
