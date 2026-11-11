// Optional implementation of the EXISTING Workflows service launch contract.
// Cloud Tasks provides durable async delivery to the IAM-protected Jobs
// service; it is one queued job per workflow execution, NOT one task per step.
import { randomUUID } from 'node:crypto';
import { NativeExecutionStore } from './executionStore.js';
import { NativeGcsReleases } from './gcsReleases.js';
import { withEnvSuffix } from '../exec/shared.js';

const STATUS = {
  ready: 'ACTIVE', waiting_effect: 'ACTIVE',
  completed: 'SUCCEEDED', cancelled: 'CANCELLED',
};

export class NativeWorkflowBackend {
  constructor({ releases, store, tasksClient, gcpProject, region,
                queue, jobsUrl, taskServiceAccount, uuid = randomUUID }) {
    if (!releases?.active || !store?.create || !store?.get ||
        !tasksClient?.createTask || !tasksClient?.queuePath ||
        typeof gcpProject !== 'string' || !gcpProject ||
        typeof region !== 'string' || !region ||
        typeof queue !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(queue) ||
        typeof taskServiceAccount !== 'string' ||
        !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(taskServiceAccount) ||
        typeof uuid !== 'function') {
      throw new Error('native backend requires trusted GCP release and task configuration');
    }
    let target;
    try { target = new URL(jobsUrl); } catch { /* validated below */ }
    if (!target || target.protocol !== 'https:' || target.pathname !== '/' ||
        target.search || target.hash || target.username || target.password) {
      throw new Error('native worker must use an IAM-protected HTTPS Jobs origin');
    }
    this.releases = releases;
    this.store = store;
    this.tasksClient = tasksClient;
    this.queuePath = tasksClient.queuePath(gcpProject, region, queue);
    this.jobsOrigin = target.origin;
    this.taskServiceAccount = taskServiceAccount;
    this.uuid = uuid;
  }

  async maybeStart({ workflowName, userId, projectId, argument }) {
    const deployedName = withEnvSuffix(workflowName);
    const active = await this.releases.active(deployedName);
    if (!active) return null; // Existing Google Workflows remains the default.
    const executionId = 'native_' + this.uuid().replaceAll('-', '');
    await this.store.create({
      executionId, userId, projectId, input: argument,
      workflowName: deployedName, artifactSha256: active.sha256,
      protocolVersion: active.protocolVersion,
      allowedOperations: active.allowedOperations,
    });
    // Only the authenticated Workflows service sends this request. Cloud
    // Tasks signs an OIDC identity that Cloud Run IAM checks before /native.
    const task = {
      // The default HTTP task deadline (10m) is too short for workflows.
      dispatchDeadline: '1800s',
      httpRequest: {
        httpMethod: 'POST',
        url: this.jobsOrigin + '/native/execute',
        headers: {
          'Content-Type': 'application/json',
          // Existing Jobs projectIdMiddleware reads the trusted header.
          'x-project-id': projectId,
        },
        body: Buffer.from(JSON.stringify({
          executionId, userId, projectId,
        })).toString('base64'),
        oidcToken: {
          serviceAccountEmail: this.taskServiceAccount,
          audience: this.jobsOrigin,
        },
      },
    };
    try {
      await this.tasksClient.createTask({
        parent: this.queuePath, task,
      });
    } catch (error) {
      // A task may have been accepted despite a network error. Fencing the
      // execution prevents an uncertain enqueue from running inadvertently.
      await this.store.cancel({ executionId, userId, projectId }).catch(() => {});
      throw error;
    }
    const executionName = 'native/' + executionId;
    const client = {
      getExecution: async ({ name }) => {
        if (name !== executionName) throw new Error('native execution name mismatch');
        const state = await this.store.get(executionId);
        if (!state || state.userId !== userId || state.projectId !== projectId) {
          throw new Error('native execution not found for authenticated owner');
        }
        return [{
          name: executionName,
          state: STATUS[state.status] || 'ACTIVE',
          ...(state.status === 'completed' ? { result: JSON.stringify(state.result) } : {}),
        }];
      },
    };
    return { executionName, client };
  }
}

let backendPromise;
// Lazily created only when explicitly enabled by server configuration.
export function configuredNativeBackend() {
  if (process.env.AWFL_NATIVE_EXECUTION_ENABLED !== '1') return Promise.resolve(null);
  backendPromise ||= (async () => {
    const { Storage } = await import('@google-cloud/storage');
    const { CloudTasksClient } = await import('@google-cloud/tasks');
    const { getFirestore } = await import('firebase-admin/firestore');
    const gcpProject = process.env.GCP_PROJECT || process.env.GCLOUD_PROJECT;
    return new NativeWorkflowBackend({
      releases: new NativeGcsReleases({
        storage: new Storage(), bucket: process.env.AWFL_NATIVE_ARTIFACT_BUCKET,
      }),
      store: new NativeExecutionStore({ db: getFirestore() }),
      tasksClient: new CloudTasksClient(),
      gcpProject,
      region: process.env.WORKFLOWS_LOCATION || 'us-central1',
      queue: process.env.AWFL_NATIVE_TASK_QUEUE,
      jobsUrl: process.env.AWFL_NATIVE_JOBS_URL,
      taskServiceAccount: process.env.AWFL_NATIVE_TASK_SERVICE_ACCOUNT,
    });
  })();
  return backendPromise;
}
