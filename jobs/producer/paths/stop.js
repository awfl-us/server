import { deleteSubscription } from '../pubsubAdmin.js';
import { stopContainer } from '../docker.js';
import { cancelOperation, cancelJobExecutions } from '../cloudRun.js';
import { deleteK8sJob } from '../gke.js';
import { setConsumerRuntimeInfo, releaseConsumerLock } from '../../../workflows/projects/lock.js';

// Unified stop path extracted from jobs/producer/index.js
// Best-effort cleanup; preserves prior response semantics per runtime mode.
export async function stopByRuntime({ userId, projectId, lock }, {
  deleteJob = deleteK8sJob,
  releaseLock = releaseConsumerLock,
  setRuntime = setConsumerRuntimeInfo,
} = {}) {
  const runtime = lock?.runtime || null;
  const results = {};
  const gcpProject = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '';

  if (runtime?.mode === 'local-docker') {
    try {
      if (runtime?.sub_req) await deleteSubscription({ gcpProject, name: runtime.sub_req });
      if (runtime?.sub_resp) await deleteSubscription({ gcpProject, name: runtime.sub_resp });
    } catch {}

    // Producer container may be absent (consumer-only mode); tolerate missing.
    const prodName = runtime?.producer?.containerName || runtime?.producer?.containerId;
    const sideName = runtime?.sidecar?.containerName || runtime?.sidecar?.containerId;
    if (prodName) {
      try { await stopContainer(prodName); results.producer = 'stopped'; } catch { results.producer = 'error'; }
    }
    if (sideName) {
      try { await stopContainer(sideName); results.sidecar = 'stopped'; } catch { results.sidecar = 'error'; }
    }

    const rel = await releaseConsumerLock({ userId, projectId, force: true });
    return { status: 200, body: { ok: true, mode: 'local-docker', results, released: rel?.released !== false } };
  }

  if (runtime?.mode === 'cloud-run') {
    try {
      if (runtime?.sub_req) await deleteSubscription({ gcpProject, name: runtime.sub_req });
      if (runtime?.sub_resp) await deleteSubscription({ gcpProject, name: runtime.sub_resp });
    } catch {}

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
    return { status: 200, body: { ok: true, mode: 'cloud-run', message: 'Stop requested. Jobs cancellation attempted. Lock released. Subscriptions deleted (best-effort).', results, released: rel?.released !== false } };
  }

  if (runtime?.mode === 'gke') {
    const ns = runtime.namespace || process.env.K8S_NAMESPACE || 'awfl';
    const jobNames = [runtime.producerJobName, runtime.consumerJobName].filter(Boolean);
    // Never release a project lock without knowing which running jobs to stop.
    if (!jobNames.length) {
      return { status: 409, body: { ok: false, error: 'Consumer runtime has no Kubernetes Job; project lock retained' } };
    }
    // The shared Kubernetes helper waits until each Job has actually disappeared.
    const jobs = await Promise.all(jobNames.map(async jobName => {
      try { return await deleteJob({ namespace: ns, jobName }); }
      catch { return { ok: false, status: 500 }; }
    }));
    results.jobs = jobs.map(job => ({ ok: Boolean(job?.ok), status: job?.status || 500 }));
    if (jobs.some(job => !job?.ok)) {
      return { status: 503, body: {
        ok: false,
        error: 'Kubernetes consumer shutdown failed; project lock retained',
        mode: 'gke', results,
      } };
    }

    // Defer optional best-effort cleanup until AFTER shutdown was confirmed.
    try {
      if (runtime.sub_req) await deleteSubscription({ gcpProject, name: runtime.sub_req });
      if (runtime.sub_resp) await deleteSubscription({ gcpProject, name: runtime.sub_resp });
    } catch {}
    try {
      await setRuntime({ userId, projectId, consumerId: lock.consumerId,
        runtime: { ...runtime, stopRequested: true, stopAt: Date.now() } });
    } catch {}

    // Never force-clear a lock acquired by a replacement consumer.
    const released = await releaseLock({ userId, projectId, consumerId: lock.consumerId });
    if (!released?.ok) {
      return { status: 409, body: { ok: false, error: 'Project consumer lock changed during shutdown; not released' } };
    }
    return { status: 200, body: {
      ok: true, mode: 'gke', released: released.released,
      message: 'Kubernetes Jobs stopped; project consumer lock released', results,
    } };
  }

  const rel = await releaseConsumerLock({ userId, projectId, force: true });
  return { status: 200, body: { ok: true, mode: runtime?.mode || 'unknown', message: 'Lock released', released: rel?.released !== false } };
}
