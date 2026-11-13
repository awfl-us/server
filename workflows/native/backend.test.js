import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudTasksClient } from '@google-cloud/tasks';
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

test('memory mode is pinned into release and IAM task only when enabled', async () => {
  const previous = process.env.AWFL_NATIVE_MEMORY_EXECUTION_ENABLED;
  process.env.AWFL_NATIVE_MEMORY_EXECUTION_ENABLED = '1';
  try {
    const f = fixture();
    const response = await f.backend.maybeStart({ workflowName: 'NativePilot',
      userId: 'owner', projectId: 'project-a', argument: { env: {} } });
    assert.equal(f.states.get(executionId).executionMode, 'memory');
    assert.deepEqual(JSON.parse(Buffer.from(f.tasks[0].task.httpRequest.body,
      'base64').toString()), { executionId, userId: 'owner',
      projectId: 'project-a', executionMode: 'memory' });
    f.states.get(executionId).status = 'running';
    assert.deepEqual(await response.client.getExecution({ name: response.executionName }),
      [{ name: response.executionName, state: 'ACTIVE' }]);
    const parallel = fixture(1, 1);
    await parallel.backend.maybeStart({ workflowName: 'NativePilot',
      userId: 'owner', projectId: 'project-a', argument: { env: {} } });
    assert.equal(parallel.states.get(executionId).executionMode, undefined);
    assert.equal(JSON.parse(Buffer.from(parallel.tasks[0].task.httpRequest.body,
      'base64').toString()).executionMode, undefined);
  } finally {
    if (previous === undefined) delete process.env.AWFL_NATIVE_MEMORY_EXECUTION_ENABLED;
    else process.env.AWFL_NATIVE_MEMORY_EXECUTION_ENABLED = previous;
  }
});

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
    assert.deepEqual(queued.task.dispatchDeadline, { seconds: 1800 });
    // Use the real Cloud Tasks protobuf serializer, not just our fake queue:
    // a string deadline ('1800s') passes mocks but fails before the RPC.
    const taskDescriptor = new CloudTasksClient()._protos.google.cloud.tasks.v2.Task;
    assert.ok(taskDescriptor.serialize(queued.task).length > 0);
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
    f.states.get(executionId).status = 'failed';
    f.states.get(executionId).error = { message: 'confirmed failure' };
    assert.deepEqual(await response.client.getExecution({ name: response.executionName }), [{
      name: response.executionName, state: 'FAILED',
      error: { message: 'confirmed failure' },
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

test('Cloud Run tagged Jobs revision uses canonical OIDC audience', async () => {
  const f = fixture();
  const tagged = new NativeWorkflowBackend({
    releases: f.backend.releases, store: f.store,
    tasksClient: {
      queuePath: () => 'projects/awfl-us/locations/us-central1/queues/native-executions',
      createTask: async arg => { f.tasks.push(arg); },
    },
    gcpProject: 'awfl-us', region: 'us-central1', queue: 'native-executions',
    jobsUrl: 'https://jobs-123-uc.a.run.app',
    taskTargetUrl: 'https://native-rust-pilot---jobs-123-uc.a.run.app',
    taskServiceAccount: 'task-worker@awfl-us.iam.gserviceaccount.com',
    uuid: () => '1'.repeat(32),
  });
  await tagged.maybeStart({ workflowName: 'NativePilot', userId: 'user',
    projectId: 'project', argument: {} });
  assert.equal(f.tasks[0].task.httpRequest.url,
    'https://native-rust-pilot---jobs-123-uc.a.run.app/native/execute');
  assert.equal(f.tasks[0].task.httpRequest.oidcToken.audience,
    'https://jobs-123-uc.a.run.app');
  assert.deepEqual(f.tasks[0].task.dispatchDeadline, { seconds: 1800 });
  assert.throws(() => new NativeWorkflowBackend({
    releases: f.backend.releases, store: f.store,
    tasksClient: { queuePath: () => 'queue', createTask: async () => {} },
    gcpProject: 'awfl-us', region: 'us-central1', queue: 'native-executions',
    jobsUrl: 'https://jobs-123-uc.a.run.app',
    taskTargetUrl: 'https://attacker.example.org',
    taskServiceAccount: 'task-worker@awfl-us.iam.gserviceaccount.com',
  }), /native task target must/);
});
