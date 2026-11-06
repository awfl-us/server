import { KubeConfig, BatchV1Api } from '@kubernetes/client-node';
import { GoogleAuth } from 'google-auth-library';

// Use the existing GKE cluster and Cloud Run identity, but no cached bearer token
// in process.env and no credentials mounted into command-execution containers.
export class GkeRuntime {
  configured() { return Boolean(process.env.MCP_EXECUTION_IMAGE && process.env.K8S_API_SERVER && process.env.K8S_CA_CERT_B64); }
  async client() {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const token = await auth.getAccessToken();
    const kc = new KubeConfig();
    kc.loadFromOptions({ clusters: [{ name: 'awfl', server: process.env.K8S_API_SERVER, caData: process.env.K8S_CA_CERT_B64 }],
      users: [{ name: 'api', token }], contexts: [{ name: 'awfl', cluster: 'awfl', user: 'api' }], currentContext: 'awfl' });
    return kc.makeApiClient(BatchV1Api);
  }
  async start({ id, token, expiresAt, origin }) {
    const client = await this.client();
    await client.createNamespacedJob('awfl-execution', workspaceJob({ id, token, expiresAt, origin, image: process.env.MCP_EXECUTION_IMAGE }));
  }
  async stop(name) {
    const client = await this.client();
    try { await client.deleteNamespacedJob(name, 'awfl-execution', undefined, undefined, 0, undefined, 'Foreground'); }
    catch (error) { if (error?.response?.statusCode !== 404) throw error; }
  }
}
export function workspaceJob({ id, token, expiresAt, origin, image }) {
  return {
    apiVersion: 'batch/v1', kind: 'Job', metadata: { name: `mcp-${id}` },
    spec: { activeDeadlineSeconds: Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)), backoffLimit: 0, ttlSecondsAfterFinished: 60,
      template: { metadata: { labels: { app: 'awfl-execution' } }, spec: {
        serviceAccountName: 'execution', automountServiceAccountToken: false, restartPolicy: 'Never',
        securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
        containers: [{ name: 'consumer', image, command: ['awfl', 'run'],
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
          resources: { requests: { cpu: '1', memory: '2Gi', 'ephemeral-storage': '4Gi' }, limits: { cpu: '2', memory: '4Gi', 'ephemeral-storage': '8Gi' } },
          env: [ { name: 'AWFL_EXECUTION_URL', value: `${origin}/mcp-consumer/${id}` },
            { name: 'AWFL_EXECUTION_TOKEN', value: token }, { name: 'AWFL_EXECUTION_EXPIRES_AT', value: String(expiresAt) } ],
          volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }, { name: 'home', mountPath: '/home/awfl' },
            { name: 'tmp', mountPath: '/tmp' }, { name: 'shm', mountPath: '/dev/shm' }],
        }], volumes: [{ name: 'workspace', emptyDir: { sizeLimit: '4Gi' } }, { name: 'home', emptyDir: { sizeLimit: '1Gi' } },
          { name: 'tmp', emptyDir: { sizeLimit: '1Gi' } }, { name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: '256Mi' } }],
      } },
    },
  };
}
