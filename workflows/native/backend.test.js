import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeWorkflowBackend } from './backend.js';
import { createWorkflowExecution } from '../services/executeWorkflow.js';

const SHA = 'a'.repeat(64);
const executionId = 'native_' + '1'.repeat(32);
function fixture(trustedGlobalsVersion, parallelVersion) {
  const states = new Map(), tasks = [], queries = [];
  let enabled = true, failTask = false;
  const store = {
    create: async state => {
      states.set(state.executionId, { ...state, status: 'ready' });
    },
    get: async id => states.get(id),
    cancel: async ({ executionId }) => {
      states.get(executionId).status = 'cancelled';
    },
  };
  const releases = {
    active: async name => {
      queries.push(name);
      return enabled && name === 'NativePilot' ? {
        workflowName: name, sha256: SHA, protocolVersion: 2,
        allowedOperations: ['http.post'],
        ...(trustedGlobalsVersion === 1 && { trustedGlobalsVersion: 1 }),
        ...(parallelVersion === 1 && { parallelVersion: 1,
          allowedOperations: ['http.post', 'native.parallel'] }),
      } : null;
    },
  };
  const tasksClient = {
    queuePath: (project, region, queue) =>
      'projects/' + project + '/locations/' + region + '/queues/' + queue,
    createTask: async value => {
      if (failTask) throw new Error('queue unavailable');
      tasks.push(value);
    },
  };
  return {
    store, states, tasks, queries,
    disable: () => { enabled = false; },
    failQueue: () => { failTask = true; },
    backend: new NativeWorkflowBackend({
      releases, store, tasksClient, gcpProject: 'awfl-us',
      region: 'us-central1', queue: 'native-executions',
      jobsUrl: 'https://jobs.example.org',
      taskServiceAccount: 'task-worker@awfl-us.iam.gserviceaccount.com',
      uuid: () => '1'.repeat(32),
    }),
  };
}

test('shared launcher pins trusted identity and returns Google-style status adapter', async () => {
  const f = fixture();
  const prev = process.env.GCP_PROJECT, base = process.env.WORKFLOWS_BASE_URL;
  process.env.GCP_PROJECT = 'awfl-us';
  process.env.WORKFLOWS_BASE_URL = 'https://jobs.example.org';
  try {
    const client = { workflowPath: () => { throw new Error('must use native'); } };
    const response = await createWorkflowExecution({
      userId: 'verified-user', projectId: 'project-a',
      workflowName: 'NativePilot', client, nativeBackend: f.backend,
      params: { env: { userId: 'spoofed', projectId: 'other' }, n: 5 },
    });
    assert.equal(response.executionName, 'native/' + executionId);
    assert.deepEqual(f.states.get(executionId).input, {
      env: { BASE_URL: 'https://jobs.example.org',
        userId: 'verified-user', projectId: 'project-a' },
      n: 5,
    });
    assert.deepEqual(f.states.get(executionId).allowedOperations, ['http.post']);
    assert.equal(f.tasks.length, 1);
    const queued = f.tasks[0];
    assert.equal(queued.task.dispatchDeadline, '1800s');
    assert.equal(queued.parent, 'projects/awfl-us/locations/us-central1/queues/native-executions');
    assert.equal(queued.task.httpRequest.url, 'https://jobs.example.org/native/execute');
    assert.equal(queued.task.httpRequest.headers['x-project-id'], 'project-a');
    assert.equal(queued.task.httpRequest.oidcToken.audience, 'https://jobs.example.org');
    const trustedTask = JSON.parse(Buffer.from(queued.task.httpRequest.body, 'base64').toString());
    assert.deepEqual(trustedTask, {
      executionId, userId: 'verified-user', projectId: 'project-a',
    });
    assert.deepEqual(await response.client.getExecution({ name: response.executionName }), [{
      name: response.executionName, state: 'ACTIVE',
    }]);
    f.states.get(executionId).status = 'completed';
    f.states.get(executionId).result = { done: true };
    assert.deepEqual(await response.client.getExecution({ name: response.executionName }), [{
      name: response.executionName, state: 'SUCCEEDED',
      result: '{"done":true}',
    }]);
    await assert.rejects(response.client.getExecution({ name: 'native/another' }),
      /execution name mismatch/);
  } finally {
    if (prev === undefined) delete process.env.GCP_PROJECT;
    else process.env.GCP_PROJECT = prev;
    if (base === undefined) delete process.env.WORKFLOWS_BASE_URL;
    else process.env.WORKFLOWS_BASE_URL = base;
  }
});

test('native capability is pinned from IAM release, not caller input', async () => {
  const f = fixture(1);
  const result = await f.backend.maybeStart({
    workflowName: 'NativePilot', userId: 'verified-user', projectId: 'tenant',
    argument: { trustedGlobalsVersion: 0, env: { GOOGLE_CLOUD_PROJECT_ID: 'spoof' } },
  });
  assert.equal(result.executionName, 'native/' + executionId);
  assert.equal(f.states.get(executionId).trustedGlobalsVersion, 1);
  assert.equal(f.states.get(executionId).input.trustedGlobalsVersion, 0);
  const oldRelease = fixture();
  await oldRelease.backend.maybeStart({
    workflowName: 'NativePilot', userId: 'verified-user', projectId: 'tenant',
    argument: { trustedGlobalsVersion: 1 },
  });
  assert.equal(Object.hasOwn(oldRelease.states.get(executionId), 'trustedGlobalsVersion'), false);
});

test('parallel capability is pinned by IAM release rather than caller input', async () => {
  const active = fixture(undefined, 1);
  await active.backend.maybeStart({
    workflowName: 'NativePilot', userId: 'owner', projectId: 'tenant',
    argument: { parallelVersion: 0, env: { parallelVersion: 0 } },
  });
  assert.equal(active.states.get(executionId).parallelVersion, 1);
  assert.deepEqual(active.states.get(executionId).allowedOperations,
    ['http.post', 'native.parallel']);
  const legacy = fixture();
  await legacy.backend.maybeStart({
    workflowName: 'NativePilot', userId: 'owner', projectId: 'tenant',
    argument: { parallelVersion: 1 },
  });
  assert.equal(Object.hasOwn(legacy.states.get(executionId), 'parallelVersion'), false);
});

test('unpublished workflows use the existing Google Workflows path unchanged', async () => {
  const f = fixture(); f.disable();
  const prev = process.env.GCP_PROJECT, base = process.env.WORKFLOWS_BASE_URL;
  process.env.GCP_PROJECT = 'awfl-us';
  process.env.WORKFLOWS_BASE_URL = 'https://jobs.example.org';
  const calls = [];
  const googleClient = {
    workflowPath: (project, region, name) =>
      'projects/' + project + '/locations/' + region + '/workflows/' + name,
    createExecution: async arg => {
      calls.push(arg);
      return [{ name: 'google/execution' }];
    },
  };
  try {
    const result = await createWorkflowExecution({
      userId: 'verified-user', projectId: 'project-a',
      workflowName: 'GoogleOnly', params: [1, 2],
      nativeBackend: f.backend, client: googleClient,
    });
    assert.equal(result.executionName, 'google/execution');
    assert.deepEqual(JSON.parse(calls[0].execution.argument),
      [{ env: { BASE_URL: 'https://jobs.example.org',
        userId: 'verified-user', projectId: 'project-a' } }, 1, 2]);
    assert.equal(f.tasks.length, 0);
  } finally {
    if (prev === undefined) delete process.env.GCP_PROJECT;
    else process.env.GCP_PROJECT = prev;
    if (base === undefined) delete process.env.WORKFLOWS_BASE_URL;
    else process.env.WORKFLOWS_BASE_URL = base;
  }
});

test('failed task creation fences the execution instead of leaving it runnable', async () => {
  const f = fixture(); f.failQueue();
  await assert.rejects(f.backend.maybeStart({
    workflowName: 'NativePilot', userId: 'user', projectId: 'proj',
    argument: { env: { userId: 'user', projectId: 'proj' } },
  }), /queue unavailable/);
  assert.equal(f.states.get(executionId).status, 'cancelled');
});
