import { ExecutionsClient } from '@google-cloud/workflows';
import { withEnvSuffix } from '../exec/shared.js';
import { configuredNativeBackend } from '../native/backend.js';

// Shared launcher for the web /workflows/execute endpoint and Agents MCP.
// Both paths run the same Google Workflow with identical session, agent and
// project arguments. No additional job, queue or session executor exists.
export async function createWorkflowExecution({
  userId, projectId, workflowName, params = {}, location,
  client = new ExecutionsClient(), nativeBackend,
}) {
  if (!userId || !projectId) throw new Error('User and project are required');
  if (typeof workflowName !== 'string' || !workflowName.trim()) throw new Error('workflowName is required');
  if (!Array.isArray(params) && (!params || typeof params !== 'object')) {
    throw new Error('params must be an array or object');
  }
  const gcpProject = process.env.GCP_PROJECT || process.env.GCLOUD_PROJECT;
  if (!gcpProject) throw new Error('GCP project ID is not configured');
  const baseUrl = process.env.BASE_URL || process.env.WORKFLOWS_BASE_URL || process.env.PUBLIC_BASE_URL;
  if (!baseUrl) throw new Error('WORKFLOWS_BASE_URL is not configured');
  const { model, background, sessionId } = params;
  const env = {
    BASE_URL: baseUrl,
    userId,
    ...(model === undefined ? {} : { model }),
    ...(background === undefined ? {} : { background }),
    projectId,
    ...(sessionId === undefined ? {} : { sessionId }),
  };
  // Keep the trusted environment last: input params must not replace auth scope.
  const argument = Array.isArray(params)
    ? [{ env }, ...params]
    : { ...params, env };
  const backend = nativeBackend === undefined
    ? await configuredNativeBackend() : nativeBackend;
  if (backend) {
    const native = await backend.maybeStart({
      userId, projectId, workflowName: workflowName.trim(), argument,
    });
    if (native) return native;
  }
  const region = location || process.env.WORKFLOWS_LOCATION || 'us-central1';
  const parent = client.workflowPath(gcpProject, region, withEnvSuffix(workflowName.trim()));
  const [execution] = await client.createExecution({
    parent,
    execution: { argument: JSON.stringify(argument) },
  });
  return { executionName: execution.name, client };
}
