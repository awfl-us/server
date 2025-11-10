import express from 'express';
import { ExecutionsClient, WorkflowsClient } from '@google-cloud/workflows';

const router = express.Router();

// GET /workflows/list
// Returns a list of available Workflows in the configured (or requested) location.
// Requires authenticate middleware.
router.get('/list', async (req, res) => {
  try {
    const gcpProjectId = process.env.GCP_PROJECT || process.env.GCLOUD_PROJECT;
    if (!gcpProjectId) {
      return res.status(500).json({ error: 'GCP project ID is not configured' });
    }

    const region = req.query.location || process.env.WORKFLOWS_LOCATION || 'us-central1';

    const client = new WorkflowsClient();
    const parent = `projects/${gcpProjectId}/locations/${region}`;

    const [response] = await client.listWorkflows({ parent });
    const workflows = (response || []).map((wf) => {
      const fullName = wf.name || '';
      const segments = fullName.split('/');
      const id = segments[segments.length - 1] || fullName;
      return {
        id,
        fullName,
        state: wf.state || null,
        description: wf.description || null,
        createTime: wf.createTime || null,
        updateTime: wf.updateTime || null,
      };
    });

    return res.status(200).json({ gcpProjectId, location: region, workflows });
  } catch (err) {
    console.error('List workflows error:', err?.response?.data || err?.message || err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// POST /workflows/execute
// Executes a Workflow with user-scoped params. Requires authenticate middleware.
// Supports both positional (array) params and named (object) params.
// New payload convention: standard env params are grouped under `env`.
// - If params is an array, the workflow argument will be [ env, ...params ]
// - If params is an object, the workflow argument will be { env, ...params }
// - If sync is true, the server returns the executionName immediately after creation, without waiting.
router.post('/execute', async (req, res) => {
  try {
    const { workflowName, params, location, sync } = req.body || {};
    const userId = req.userId;

    if (!workflowName || typeof workflowName !== 'string') {
      return res.status(400).json({ error: 'workflowName (string) is required' });
    }
    if (
      params !== undefined &&
      !(
        Array.isArray(params) ||
        (params !== null && typeof params === 'object')
      )
    ) {
      return res.status(400).json({ error: 'params must be an array or object if provided' });
    }

    const gcpProjectId = process.env.GCP_PROJECT || process.env.GCLOUD_PROJECT;
    if (!gcpProjectId) {
      return res.status(500).json({ error: 'GCP project ID is not configured' });
    }

    const region = location || process.env.WORKFLOWS_LOCATION || 'us-central1';
    const workflowWithEnv = `${workflowName}${process.env.WORKFLOW_ENV || ''}`;

    // Resolve BASE_URL from environment
    const baseUrl = process.env.BASE_URL || process.env.WORKFLOWS_BASE_URL || process.env.PUBLIC_BASE_URL;
    if (!baseUrl) {
      return res.status(500).json({ error: 'WORKFLOWS_BASE_URL is not configured in environment' });
    }

    const { model, background, sessionId } = params;
    const projectId = req.projectId;


    // Build the argument, grouping standard env params under `env`
    // Array params => positional: [ { env }, ...params ]
    // Object params => named: { env, ...params }
    const env = {
      BASE_URL: baseUrl,
      userId,
      ...(model === undefined ? {} : { model }),
      ...(background === undefined ? {} : { background }),
      ...(projectId === undefined ? {} : { projectId }),
      ...(sessionId === undefined ? {} : { sessionId }),
    };

    let argumentPayload;
    if (Array.isArray(params)) {
      argumentPayload = [{ env }, ...params];
    } else if (params && typeof params === 'object') {
      argumentPayload = { env, ...params };
    } else {
      // No params provided: default to named shape to include env explicitly
      argumentPayload = { env };
    }

    const client = new ExecutionsClient();
    const parent = client.workflowPath(gcpProjectId, region, workflowWithEnv);

    const [execution] = await client.createExecution({
      parent,
      execution: {
        // Inside your Workflow, access either positional args (args[0] is { env }, args[1], ...)
        // or named args (args.env, args.kala, ...), depending on the shape sent.
        argument: JSON.stringify(argumentPayload),
      },
    });

    const executionName = execution.name;

    // If sync is truthy, return immediately with the execution name (no polling)
    const syncRequested = sync === true || sync === 'true' || sync === 1 || sync === '1';
    if (syncRequested) {
      return res.status(202).json({ executionName });
    }

    // Poll for completion (up to WORKFLOWS_SYNC_TIMEOUT_MS or 60s)
    const timeoutMs = Number(process.env.WORKFLOWS_SYNC_TIMEOUT_MS) || 60000;
    const deadline = Date.now() + timeoutMs;
    let backoffMs = 500;

    while (true) {
      const [current] = await client.getExecution({ name: executionName });

      if (current.state === 'SUCCEEDED') {
        let result = current.result;
        try { result = JSON.parse(result); } catch (_) {}
        return res.status(200).json({ executionName, state: current.state, result });
      }

      if (current.state === 'FAILED' || current.state === 'CANCELLED') {
        return res.status(500).json({ executionName, state: current.state, error: current.error || 'Execution did not succeed' });
      }

      if (Date.now() > deadline) {
        return res.status(504).json({ executionName, state: current.state, error: 'Workflow execution timed out' });
      }

      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 1.5, 2000);
    }
  } catch (err) {
    console.error('Workflow invocation error:', err?.response?.data || err?.message || err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

export default router;
