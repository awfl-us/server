import { KubeConfig, BatchV1Api } from '@kubernetes/client-node';

function getBatchClient() {
  const kc = new KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST) kc.loadFromCluster();
  else kc.loadFromDefault();
  const batch = kc.makeApiClient(BatchV1Api);
  return { kc, batch };
}

export async function runK8sJob({ namespace, jobName, image, serviceAccountName, envPairs = [], containerName = 'main', ttlSecondsAfterFinished = 3600, backoffLimit = 0, command, args, shCommand }) {
  if (!namespace) return { ok: false, status: 400, error: 'Missing namespace' };
  if (!jobName) return { ok: false, status: 400, error: 'Missing jobName' };
  if (!image) return { ok: false, status: 400, error: 'Missing image' };
  try {
    const { batch } = getBatchClient();
    const container = {
      name: containerName || 'main',
      image,
      env: (Array.isArray(envPairs) ? envPairs : []).map((e) => ({ name: String(e.name), value: String(e.value ?? '') })),
    };

    if (Array.isArray(command) && command.length) {
      container.command = command.map(String);
    } else if (typeof shCommand === 'string' && shCommand.trim()) {
      container.command = ['sh', '-lc', shCommand];
    }
    if (Array.isArray(args) && args.length) container.args = args.map(String);

    const job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: jobName,
        labels: {
          'app.kubernetes.io/name': 'awfl-producer-consumer',
          'app.kubernetes.io/part-of': 'awfl',
        },
      },
      spec: {
        ttlSecondsAfterFinished,
        backoffLimit,
        template: {
          metadata: {
            labels: {
              'app.kubernetes.io/name': 'awfl-producer-consumer',
            },
          },
          spec: {
            serviceAccountName: serviceAccountName || undefined,
            restartPolicy: 'Never',
            containers: [container],
          },
        },
      },
    };

    const resp = await batch.createNamespacedJob(namespace, job);
    return { ok: true, status: resp?.response?.statusCode || 200, data: resp?.body };
  } catch (e) {
    const status = e?.response?.statusCode || 500;
    const msg = e?.response?.body || e?.message || String(e);
    return { ok: false, status, error: msg };
  }
}

export async function deleteK8sJob({ namespace, jobName, propagationPolicy = 'Background' }) {
  if (!namespace || !jobName) return { ok: false, status: 400, error: 'Missing namespace/jobName' };
  try {
    const { batch } = getBatchClient();
    const resp = await batch.deleteNamespacedJob(jobName, namespace, undefined, undefined, 0, undefined, propagationPolicy);
    return { ok: true, status: resp?.response?.statusCode || 200, data: resp?.body };
  } catch (e) {
    // Treat 404 as success (already deleted)
    const code = e?.response?.statusCode;
    if (code === 404) return { ok: true, status: 200, data: { message: 'Not found (treated as deleted)' } };
    return { ok: false, status: code || 500, error: e?.response?.body || e?.message || String(e) };
  }
}
