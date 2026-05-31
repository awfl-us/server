import { KubeConfig, BatchV1Api } from '@kubernetes/client-node';

function buildServerUrl(input) {
  if (!input) return '';
  let s = String(input).trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s;
}

function isLocalhostHost(h) {
  const host = String(h || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function getBatchClient() {
  const kc = new KubeConfig();
  let mode = 'default';
  const inCloudRun = Boolean(process.env.K_SERVICE || process.env.K_REVISION || process.env.CLOUD_RUN_JOB);

  try {
    if (process.env.KUBERNETES_SERVICE_HOST) {
      // Running inside a Kubernetes pod
      kc.loadFromCluster();
      mode = 'inCluster';
    } else if (process.env.K8S_API_SERVER || process.env.K8S_API_ENDPOINT) {
      // Out-of-cluster: construct config from env
      const server = buildServerUrl(process.env.K8S_API_SERVER || process.env.K8S_API_ENDPOINT);
      const skipTls = String(process.env.K8S_INSECURE_SKIP_TLS_VERIFY || process.env.K8S_SKIP_TLS_VERIFY || '') === '1';
      const caData = process.env.K8S_CA_CERT_B64 || process.env.K8S_CA_DATA_B64 || '';
      const caFile = process.env.K8S_CA_FILE || '';
      const token = process.env.K8S_BEARER_TOKEN || '';

      try {
        const u = new URL(server);
        if (isLocalhostHost(u.hostname)) {
          throw new Error('K8S_API_SERVER points to localhost; set it to your GKE API endpoint URL');
        }
      } catch (e) {
        // If server is malformed, let it error later with details
      }

      const cluster = { name: 'awfl-cluster', server };
      if (skipTls) cluster['skipTLSVerify'] = true;
      if (caData) cluster['caData'] = caData;
      if (caFile) cluster['caFile'] = caFile;

      const user = { name: 'awfl-user' };
      if (token) user['token'] = token;

      const context = { name: 'awfl-ctx', cluster: cluster.name, user: user.name };
      kc.loadFromOptions({ clusters: [cluster], users: [user], contexts: [context], currentContext: context.name });
      mode = 'env';

      try {
        console.log('[jobs/producer:gke:kubeconfig] configured', {
          mode,
          server,
          skipTls,
          hasToken: Boolean(token),
          hasCaData: Boolean(caData || caFile),
        });
      } catch {}
    } else {
      if (inCloudRun) {
        // In Cloud Run without explicit config -> fail fast to avoid localhost defaults
        const help = 'No Kubernetes config detected. Set K8S_API_SERVER (https URL to your cluster endpoint) and optionally K8S_CA_CERT_B64 or K8S_INSECURE_SKIP_TLS_VERIFY=1.';
        throw new Error(help);
      }
      // Fallback: attempt to use local kubeconfig (~/.kube/config) in dev
      kc.loadFromDefault();
      mode = 'default';
      try {
        console.warn('[jobs/producer:gke:kubeconfig] using default kubeconfig (dev). In Cloud Run, set K8S_API_SERVER to target your GKE cluster');
      } catch {}
    }
  } catch (e) {
    // As a last resort, attempt default only in local dev and surface error on API call
    if (!inCloudRun) {
      try { kc.loadFromDefault(); mode = 'default-error-fallback'; } catch {}
    }
    try { console.warn('[jobs/producer:gke:kubeconfig] error loading config', String(e?.message || e)); } catch {}
    if (inCloudRun) throw e; // bubble up in Cloud Run so caller can return a clear error
  }

  const batch = kc.makeApiClient(BatchV1Api);
  return { kc, batch, mode };
}

async function fetchMetadataAccessToken({ timeoutMs = 1500 } = {}) {
  // Cloud Run/Compute/GKE metadata server token endpoint. Returns { access_token, expires_in, token_type }
  const url = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Math.max(500, timeoutMs));
  try {
    const res = await fetch(url, { headers: { 'Metadata-Flavor': 'Google' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`metadata token HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.access_token) throw new Error('metadata token missing access_token');
    return { token: String(data.access_token), expiresIn: Number(data.expires_in || 0) };
  } finally {
    clearTimeout(t);
  }
}

export async function runK8sJob({ namespace, jobName, image, serviceAccountName, envPairs = [], containerName = 'main', ttlSecondsAfterFinished = 3600, backoffLimit = 0, command, args, shCommand }) {
  if (!namespace) return { ok: false, status: 400, error: 'Missing namespace' };
  if (!jobName) return { ok: false, status: 400, error: 'Missing jobName' };
  if (!image) return { ok: false, status: 400, error: 'Missing image' };
  try {
    // If running in Cloud Run and talking to an external K8s API without a provided token, fetch a Google access token
    const inCloudRun = Boolean(process.env.K_SERVICE || process.env.K_REVISION || process.env.CLOUD_RUN_JOB);
    const hasExtApi = Boolean(process.env.K8S_API_SERVER || process.env.K8S_API_ENDPOINT);
    if (inCloudRun && hasExtApi && !process.env.K8S_BEARER_TOKEN) {
      try {
        const { token } = await fetchMetadataAccessToken({ timeoutMs: 1500 });
        if (token) process.env.K8S_BEARER_TOKEN = token;
        try { console.log('[jobs/producer:gke] acquired access token from metadata server for K8s API'); } catch {}
      } catch (e) {
        try { console.warn('[jobs/producer:gke] failed to get metadata access token; ensure Cloud Run SA has default access and metadata server is reachable', String(e?.message || e)); } catch {}
      }
    }

    const { batch, mode } = getBatchClient();
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
              'app.kubernetes.io/name': 'awfl-consumer',
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

    try {
      console.log('[jobs/producer:gke] creating K8s Job', { namespace, jobName, image, kubeconfigMode: mode });
    } catch {}

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
