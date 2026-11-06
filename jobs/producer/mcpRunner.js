import { runK8sJob, deleteK8sJob } from './gke.js';
import { loadConsumerCredentials } from './credentials.js';

// Adapter only: reuse the exact GKE launcher/image/namespace/service account
// already used by the AWFL cloud consumer. No new namespace or controller.
export function mcpConsumerEnv({ id, token, expiresAt, origin, projectId, credentials = {} }) {
  const env = [
    { name: 'AWFL_EXECUTION_URL', value: origin.replace(/\/$/, '') + '/mcp-consumer/' + id },
    { name: 'AWFL_EXECUTION_TOKEN', value: token },
    { name: 'AWFL_EXECUTION_EXPIRES_AT', value: String(expiresAt) },
    { name: 'AWFL_CONSUMER_TYPE', value: 'CLOUD' },
    { name: 'CONSUMER_ID', value: 'mcp-' + id },
    { name: 'API_ORIGIN', value: origin.replace(/\/$/, '') },
    { name: 'WORKFLOWS_BASE_URL', value: origin.replace(/\/$/, '') },
  ];
  if (projectId) env.push({ name: 'AWFL_PROJECT_ID', value: projectId });
  if (credentials.githubToken) env.push({ name: 'GITHUB_TOKEN', value: credentials.githubToken });
  if (credentials.firebaseIdToken) env.push({ name: 'FIREBASE_ID_TOKEN', value: credentials.firebaseIdToken });
  if (credentials.firebaseCustomToken) env.push({ name: 'FIREBASE_CUSTOM_TOKEN', value: credentials.firebaseCustomToken });
  return env;
}

export class ExistingConsumerRuntime {
  constructor({ launch = runK8sJob, remove = deleteK8sJob, credentials = loadConsumerCredentials } = {}) {
    Object.assign(this, { launch, remove, credentials });
  }
  namespace() { return process.env.K8S_NAMESPACE || 'awfl'; }
  configured() {
    return Boolean(process.env.CONSUMER_K8S_IMAGE &&
      (process.env.K8S_API_SERVER || process.env.K8S_API_ENDPOINT || process.env.KUBERNETES_SERVICE_HOST));
  }
  async start({ id, token, expiresAt, origin, userId, projectId }) {
    const creds = await this.credentials({ userId, projectId });
    const result = await this.launch({
      namespace: this.namespace(),
      jobName: 'mcp-' + id,
      image: process.env.CONSUMER_K8S_IMAGE,
      serviceAccountName: process.env.CONSUMER_KSA_NAME || 'consumer',
      containerName: 'consumer',
      ttlSecondsAfterFinished: 60,
      backoffLimit: 0,
      // Use the CLI version baked into the regular consumer image, never a
      // runtime pip install that could silently downgrade its MCP support.
      command: ['awfl', 'run'],
      envPairs: mcpConsumerEnv({ id, token, expiresAt, origin, projectId, credentials: creds }),
    });
    if (!result?.ok) throw new Error('Unable to start AWFL consumer Job');
  }
  async stop(name) {
    const result = await this.remove({ namespace: this.namespace(), jobName: name, propagationPolicy: 'Foreground' });
    if (!result?.ok) throw new Error('Unable to stop AWFL consumer Job');
  }
}
