import { deleteSubscription } from '../pubsubAdmin.js';
import { stopContainer } from '../docker.js';
import { cancelOperation, cancelJobExecutions } from '../cloudRun.js';
import { deleteK8sJob } from '../gke.js';
import { setConsumerRuntimeInfo, releaseConsumerLock } from '../../../workflows/projects/lock.js';

// Unified stop path extracted from jobs/producer/index.js
// Best-effort cleanup; preserves prior response semantics per runtime mode.
export async function stopByRuntime({ userId, projectId, lock }) {
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
    try {
      if (runtime?.sub_req) await deleteSubscription({ gcpProject, name: runtime.sub_req });
      if (runtime?.sub_resp) await deleteSubscription({ gcpProject, name: runtime.sub_resp });
    } catch {}

    const ns = runtime?.namespace || process.env.K8S_NAMESPACE || 'awfl';
    const delOps = [];
    // producerJobName may be null in consumer-only mode; ignore when absent.
    if (runtime?.producerJobName) delOps.push(deleteK8sJob({ namespace: ns, jobName: runtime.producerJobName }).catch(() => ({ ok: false })));
    if (runtime?.consumerJobName) delOps.push(deleteK8sJob({ namespace: ns, jobName: runtime.consumerJobName }).catch(() => ({ ok: false })));

    try {
      const settled = await Promise.allSettled(delOps);
      results.jobs = settled.map(s => (s.status === 'fulfilled' ? s.value : { ok: false }));
    } catch {}

    try {
      await setConsumerRuntimeInfo({ userId, projectId, consumerId: lock.consumerId, runtime: { ...runtime, stopRequested: true, stopAt: Date.now() } });
    } catch {}

    const rel = await releaseConsumerLock({ userId, projectId, force: true });
    return { status: 200, body: { ok: true, mode: 'gke', message: 'Stop requested. K8s Jobs deleted (best-effort). Lock released. Subscriptions deleted (best-effort).', results, released: rel?.released !== false } };
  }

  const rel = await releaseConsumerLock({ userId, projectId, force: true });
  return { status: 200, body: { ok: true, mode: runtime?.mode || 'unknown', message: 'Lock released', released: rel?.released !== false } };
}
