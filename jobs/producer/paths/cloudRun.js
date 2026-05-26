import { runCloudRunJob, cancelOperation } from '../cloudRun.js';
import { buildProducerEnv } from '../envBuilder.js';
import { deleteSubscription } from '../pubsubAdmin.js';
import { setConsumerRuntimeInfo } from '../../../workflows/projects/lock.js';
import { scheduleStartupProgress, cancelStartupProgress } from '../progress.js';
import { monitorCloudRunStartup } from '../readiness.js';

// Extracted Cloud Run start path. Keeps behavior identical to the inline block previously in index.js
export async function startCloudRun({
  userId,
  projectId,
  lock,
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
}) {
  const consumerJobName = process.env.CONSUMER_CLOUD_RUN_JOB_NAME || '';
  const producerJobName = process.env.PRODUCER_CLOUD_RUN_JOB_NAME || process.env.CLOUD_RUN_JOB_NAME;
  const producerContainerName = process.env.PRODUCER_CONTAINER_NAME || process.env.CLOUD_RUN_CONTAINER_NAME || 'producer';

  if (!producerJobName) {
    await bestEffortRelease({ userId, projectId });
    return { status: 500, body: { error: 'Server missing PRODUCER_CLOUD_RUN_JOB_NAME' } };
  }
  if (!consumerJobName) {
    await bestEffortRelease({ userId, projectId });
    return { status: 500, body: { error: 'Server missing CONSUMER_CLOUD_RUN_JOB_NAME' } };
  }

  const consumerOverrides = [{
    name: 'consumer',
    ...(requestedConsumerImage ? { image: requestedConsumerImage } : {}),
    env: [
      { name: 'SUBSCRIPTION', value: subReq },
      { name: 'ENC_KEY_B64', value: encKeyB64 },
      { name: 'ENC_VER', value: encVer },
      { name: 'REPLY_CHANNEL', value: 'resp' },
      { name: 'GCS_DEBUG', value: '1' },
      { name: 'GCS_TRACE', value: '1' },
      { name: 'CONSUMER_ID', value: consumerId },
      { name: 'AWFL_PROJECT_ID', value: String(projectId) },
      { name: 'AWFL_CONSUMER_TYPE', value: 'CLOUD' },
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
  if (gcsPrefix) producerEnvPairs.push({ name: 'GCS_PREFIX', value: gcsPrefix });
  const producerOverrides = [{ name: producerContainerName, env: [...producerEnvPairs, { name: 'SUBSCRIPTION', value: subResp }] }];

  let consumerRun, producerRun;
  try {
    [consumerRun, producerRun] = await Promise.all([
      runCloudRunJob({ gcpProject, location, jobName: consumerJobName, containerOverrides: consumerOverrides }),
      runCloudRunJob({ gcpProject, location, jobName: producerJobName, containerOverrides: producerOverrides }),
    ]);
  } catch (e) {
    await deleteSubscription({ gcpProject, name: subReq }).catch(() => {});
    await deleteSubscription({ gcpProject, name: subResp }).catch(() => {});
    await bestEffortRelease({ userId, projectId });
    cancelStartupProgress({ userId, projectId, reason: 'cloud-run launch transport error' });
    return { status: 500, body: { error: 'Transport error starting Cloud Run jobs', details: String(e?.message || e) } };
  }

  if (!consumerRun?.ok || !producerRun?.ok) {
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
    cancelStartupProgress({ userId, projectId, reason: 'cloud-run start failed' });
    return { status, body: { error: 'Failed to start jobs', consumer: consumerRun, producer: producerRun } };
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
    console.warn('[jobs/producer:cloud-run] failed to persist runtime info', e?.message || e);
  }

  const sched = scheduleStartupProgress({ userId, projectId });
  if (!sched?.ok) console.warn('[jobs/producer:cloud-run] progress schedule failed', sched);
  else console.log('[jobs/producer:cloud-run] progress scheduled', { userId, projectId });

  try {
    void monitorCloudRunStartup({
      userId,
      projectId,
      producerOperationName: producerRun.data.name || null,
      consumerOperationName: consumerRun.data.name || null,
      timeoutMs: 90_000,
    });
  } catch (e) {
    console.warn('[jobs/producer:cloud-run] readiness monitor failed to start', e?.message || e);
  }

  return {
    status: 202,
    body: {
      ok: true,
      mode: 'cloud-run',
      producerJob: producerJobName,
      consumerJob: consumerJobName,
      location,
      operation: producerRun.data.name || null,
      consumerOperation: consumerRun.data.name || null,
      consumerId,
      lock: lock?.lock || null,
      workspaceId,
      sidecarEnabled,
      sessionId: sessionIdForFilter || null,
      enc_ver: encVer,
      enc_fp: encFp,
      sub_req: subReq,
      sub_resp: subResp,
      topic,
      consumerImage: requestedConsumerImage || null,
    },
  };
}
