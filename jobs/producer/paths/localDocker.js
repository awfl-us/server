import { buildLocalConsumerEnv } from '../envBuilder.js';
import { runLocalDocker } from '../docker.js';
import { setConsumerRuntimeInfo } from '../../../workflows/projects/lock.js';
import { scheduleStartupProgress, completeStartupProgress, cancelStartupProgress } from '../progress.js';
import { splitArgs, applyTemplate } from '../utils.js';
import { deleteSubscription } from '../pubsubAdmin.js';

// Updated Local Docker start path: only start the consumer (CLI), no producer container.
export async function startLocalDocker({
  userId,
  projectId,
  consumerId,
  gcpProject,
  gcsPrefix, // unused in consumer-only mode
  baseCtx,
  encKeyB64,
  encVer,
  encFp,
  topic,
  subReq,
  subResp, // unused in consumer-only mode
  sessionIdForFilter,
  workspaceId,
  sidecarEnabled, // ignored; we always launch the consumer
  sidecarImage,
  sidecarArgsTemplate,
  localDockerImage, // unused in consumer-only mode
  localDockerArgs, // unused in consumer-only mode
  githubToken,
  since_id, // unused in consumer-only mode
  since_time, // unused in consumer-only mode
  leaseMs, // unused in consumer-only mode (lock now managed by consumer CLI)
  bestEffortRelease,
  // Per-request auth tokens for the caller
  firebaseIdToken,
  firebaseCustomToken,
  // External lock wiring
  lockToken,
  lockId,
}) {
  const consumerImage = sidecarImage || 'awfl-consumer:dev';
  const consumerContainerName = `consumer-${consumerId}`.slice(0, 63);

  try {
    const sched = scheduleStartupProgress({ userId, projectId });
    if (!sched?.ok) console.warn('[jobs/producer:local-docker] progress schedule failed', sched);

    // Build consumer environment
    const consumerEnv = buildLocalConsumerEnv({
      workflowsBaseUrl: baseCtx.workflowsBaseUrl,
      eventsHeartbeatMs: baseCtx.eventsHeartbeatMs,
      reconnectBackoffMs: baseCtx.reconnectBackoffMs,
      encKeyB64,
      encVer,
      topic,
      subReq,
      projectId,
      consumerType: 'CLOUD',
    });

    // Ensure the consumer can refresh/hold the same lock by id
    consumerEnv.push({ name: 'CONSUMER_ID', value: String(consumerId) });
    consumerEnv.push({ name: 'AWFL_CONSUMER_ID', value: String(consumerId) });

    // External project lock envs (awfl CLI will honor these)
    if (lockToken) {
      consumerEnv.push({ name: 'AWFL_PROJECT_LOCK_TOKEN', value: String(lockToken) });
      consumerEnv.push({ name: 'AWFL_LOCK_TOKEN', value: String(lockToken) });
    }
    if (lockId) {
      consumerEnv.push({ name: 'AWFL_PROJECT_LOCK_ID', value: String(lockId) });
      consumerEnv.push({ name: 'AWFL_LOCK_ID', value: String(lockId) });
    }
    if (leaseMs) consumerEnv.push({ name: 'AWFL_LOCK_LEASE_MS', value: String(leaseMs) });

    // Optional passthrough for disabling local renewal when supervisor refreshes the lease
    for (const name of ['AWFL_PROJECT_LOCK_NO_REFRESH', 'AWFL_LOCK_NO_REFRESH']) {
      if (process.env[name]) consumerEnv.push({ name, value: String(process.env[name]) });
    }

    // Auth/env overrides for the consumer-only container
    const authEnvPairs = [];
    if (firebaseIdToken) authEnvPairs.push({ name: 'FIREBASE_ID_TOKEN', value: String(firebaseIdToken) });
    else if (firebaseCustomToken) authEnvPairs.push({ name: 'FIREBASE_CUSTOM_TOKEN', value: String(firebaseCustomToken) });
    if (process.env.SKIP_AUTH) authEnvPairs.push({ name: 'SKIP_AUTH', value: String(process.env.SKIP_AUTH) });
    if (process.env.AWFL_TOKENS_JSON_B64) authEnvPairs.push({ name: 'AWFL_TOKENS_JSON_B64', value: String(process.env.AWFL_TOKENS_JSON_B64) });
    if (process.env.AWFL_TOKENS_JSON) authEnvPairs.push({ name: 'AWFL_TOKENS_JSON', value: String(process.env.AWFL_TOKENS_JSON) });
    consumerEnv.push(...authEnvPairs);

    // Pass through GitHub token if available (do not log)
    if (githubToken) consumerEnv.push({ name: 'GITHUB_TOKEN', value: String(githubToken) });

    // Render any extra docker args for the consumer
    const renderedArgs = applyTemplate(sidecarArgsTemplate || '', {});
    const consumerExtraArgs = [
      '--label', 'awfl.role=sse-consumer',
      ...(consumerContainerName ? ['--label', `awfl.container=${consumerContainerName}`] : []),
      ...splitArgs(renderedArgs),
    ];

    // Default startup script for the consumer (overridable)
    const defaultStartup = 'set -e; '
      + 'python -m pip install --user awfl && "$HOME/.local/bin/awfl" dev';
    const startupSh = process.env.AWFL_STARTUP_SH || defaultStartup;

    const consumerInfo = await runLocalDocker({
      image: consumerImage,
      containerName: consumerContainerName,
      envPairs: consumerEnv,
      extraArgs: consumerExtraArgs,
      shCommand: startupSh,
    });

    // Persist runtime info: producer omitted
    try {
      await setConsumerRuntimeInfo({
        userId,
        projectId,
        consumerId,
        runtime: {
          mode: 'local-docker',
          producer: null,
          sidecar: { containerName: consumerContainerName, containerId: consumerInfo?.id || null },
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
      console.warn('[jobs/producer:local-docker] failed to persist runtime info', e?.message || e);
    }

    try { completeStartupProgress({ userId, projectId, reason: 'local-docker consumer started' }); } catch (e) { console.warn('[jobs/producer:local-docker] progress early-complete failed', e?.message || e); }

    return {
      status: 202,
      body: {
        ok: true,
        mode: 'local-docker',
        consumerImage,
        containerName: consumerContainerName,
        containerId: consumerInfo?.id || null,
        consumerId,
        workspaceId,
        sessionId: sessionIdForFilter || null,
        enc_ver: encVer,
        enc_fp: encFp,
        sub_req: subReq,
        sub_resp: subResp,
        topic,
      },
    };
  } catch (e) {
    console.error('[jobs/producer:local-docker] start error', e);
    await deleteSubscription({ gcpProject, name: subReq }).catch(() => {});
    await deleteSubscription({ gcpProject, name: subResp }).catch(() => {});
    await bestEffortRelease({ userId, projectId });
    cancelStartupProgress({ userId, projectId, reason: 'local-docker error' });
    return { status: 500, body: { error: 'Failed to start local docker consumer', details: String(e?.message || e) } };
  }
}
