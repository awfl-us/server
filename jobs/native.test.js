import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createNativeJobsRouter, nativeHybridAsyncSchedulerFor,
  startNativeDetachedRecovery } from './native.js';

function appFor(underTest) {
  const app = express();
  app.use(express.json());
  // Simulate verified Cloud Run IAM + existing workflowsUserInject middleware.
  app.use((req, _res, next) => {
    req.userId = 'verified-user';
    req.projectId = 'project-a';
    next();
  });
  app.use('/native', createNativeJobsRouter(underTest));
  return app;
}

const previousEnabled = process.env.AWFL_NATIVE_EXECUTION_ENABLED;
process.env.AWFL_NATIVE_EXECUTION_ENABLED = '1';
test.after(() => {
  if (previousEnabled === undefined) delete process.env.AWFL_NATIVE_EXECUTION_ENABLED;
  else process.env.AWFL_NATIVE_EXECUTION_ENABLED = previousEnabled;
});

test('native Jobs endpoint is unavailable until explicitly enabled', async () => {
  const app = appFor({ store: {}, releases: {}, handlers: {},
    execute: async () => { throw new Error('should not execute'); },
  });
  delete process.env.AWFL_NATIVE_EXECUTION_ENABLED;
  try {
    assert.equal((await request(app).post('/native/execute')
      .send({ executionId: 'native_' + 'a'.repeat(32) })).status, 404);
  } finally {
    process.env.AWFL_NATIVE_EXECUTION_ENABLED = '1';
  }
});

test('internal Jobs native route executes only with verified task context', async () => {
  const calls = [];
  const app = appFor({
    store: {}, releases: {}, handlers: {},
    execute: async args => {
      calls.push(args);
      return { done: true };
    },
  });
  const id = 'native_' + 'a'.repeat(32);
  const res = await request(app).post('/native/execute')
    .send({ executionId: id, userId: 'spoofed', projectId: 'wrong' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { state: 'SUCCEEDED', result: { done: true } });
  assert.equal(calls[0].userId, 'verified-user');
  assert.equal(calls[0].projectId, 'project-a');
  assert.equal(calls[0].executionId, id);
  assert.equal(calls.length, 1);
  assert.equal((await request(app).post('/native/execute')
    .send({ executionId: '../escape' })).status, 400);
  assert.equal(calls.length, 1);
});

test('IAM-authenticated memory launch selects pinned worker with scoped task identity', async () => {
  let observed;
  const app = appFor({ store: {}, releases: {}, handlers: {},
    execute: async () => { throw new Error('durable path should not run'); },
    executeMemory: async args => {
      observed = args;
      return { done: true };
    },
  });
  const id = 'native_' + 'd'.repeat(32);
  const response = await request(app).post('/native/execute')
    .send({ executionId: id, executionMode: 'memory',
      userId: 'forged-user', projectId: 'forged-project' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { state: 'SUCCEEDED', result: { done: true } });
  assert.equal(observed.executionId, id);
  assert.equal(observed.userId, 'verified-user');
  assert.equal(observed.projectId, 'project-a');
});

test('failed native Jobs worker returns retriable error without exposing details', async () => {
  const app = appFor({
    store: {}, releases: {}, handlers: {},
    execute: async () => { throw new Error('sensitive internal credential'); },
  });
  const res = await request(app).post('/native/execute')
    .send({ executionId: 'native_' + 'b'.repeat(32) });
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'Native execution unavailable');
  assert.equal(JSON.stringify(res.body).includes('sensitive'), false);
});

test('terminal workflow failure returns HTTP 200, avoiding automatic Tasks replay', async () => {
  const app = appFor({ store: {}, releases: {}, handlers: {},
    execute: async () => ({ status: 'failed', error: { message: 'test error' } }),
  });
  const response = await request(app).post('/native/execute')
    .send({ executionId: 'native_' + 'e'.repeat(32) });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { state: 'FAILED' });
});

test('opt-in native timing leaves HTTP payload unchanged and uses scoped IDs only', async () => {
  const original = process.env.AWFL_NATIVE_PROFILE_ENABLED;
  process.env.AWFL_NATIVE_PROFILE_ENABLED = '1';
  const messages = [];
  const originalInfo = console.info;
  console.info = value => messages.push(value);
  try {
    const id = 'native_' + 'c'.repeat(32);
    const app = appFor({
      store: { get: async () => true },
      releases: { materialize: async () => true },
      handlers: Object.freeze({ 'http.get': async () => ({ code: 200 }) }),
      execute: async ({ store, releases, handlers }) => {
        await store.get(); await releases.materialize();
        await handlers['http.get']({ payloadMarker: 'test_input_marker' });
        return { done: true };
      },
    });
    const res = await request(app).post('/native/execute').send({ executionId: id });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { state: 'SUCCEEDED', result: { done: true } });
    assert.equal(messages.length, 3);
    const profile = messages.map(line => JSON.parse(line))
      .find(entry => entry.event === 'awfl_native_job_timing');
    assert.ok(messages.some(line => JSON.parse(line).event === 'awfl_native_execution_started'));
    assert.ok(messages.some(line => JSON.parse(line).event === 'awfl_native_execution_completed'));
    assert.equal(profile.executionId, id);
    assert.equal(profile.outcome, 'completed');
    assert.equal(profile.phases['firestore.get'].count, 1);
    assert.equal(JSON.stringify(messages).includes('test_input_marker'), false);
  } finally {
    console.info = originalInfo;
    if (original === undefined) delete process.env.AWFL_NATIVE_PROFILE_ENABLED;
    else process.env.AWFL_NATIVE_PROFILE_ENABLED = original;
  }
});

test('experimental document-store Jobs route rejects durable tasks without fallback', async () => {
  const prev = process.env.AWFL_NATIVE_DOCUMENT_STORE_ENABLED;
  process.env.AWFL_NATIVE_DOCUMENT_STORE_ENABLED = '1';
  let called = 0;
  try {
    const app = appFor({ store: { name: 'legacy' }, releases: {}, handlers: {},
      execute: async () => { called++; return { done: true }; },
    });
    const res = await request(app).post('/native/execute')
      .send({ executionId: 'native_' + 'a'.repeat(32) });
    assert.equal(res.status, 503);
    assert.equal(called, 0);
  } finally {
    if (prev === undefined) delete process.env.AWFL_NATIVE_DOCUMENT_STORE_ENABLED;
    else process.env.AWFL_NATIVE_DOCUMENT_STORE_ENABLED = prev;
  }
});

test('experimental document-store Jobs executes memory task on injected store only', async () => {
  const prev = process.env.AWFL_NATIVE_DOCUMENT_STORE_ENABLED;
  process.env.AWFL_NATIVE_DOCUMENT_STORE_ENABLED = '1';
  const docStore = { name: 'document-storage' }, legacy = { name: 'legacy' };
  let observed;
  try {
    const app = appFor({ store: legacy, memoryStore: docStore, releases: {}, handlers: {},
      execute: async () => { throw new Error('durable runner must not run'); },
      executeMemory: async ({store}) => { observed=store; return {ok:true}; },
    });
    const res = await request(app).post('/native/execute')
      .send({ executionId: 'native_'+'c'.repeat(32), executionMode: 'memory' });
    assert.equal(res.status, 200);
    assert.equal(observed, docStore);
  } finally {
    if (prev === undefined) delete process.env.AWFL_NATIVE_DOCUMENT_STORE_ENABLED;
    else process.env.AWFL_NATIVE_DOCUMENT_STORE_ENABLED = prev;
  }
});


test('terminal failure logs the persisted error and profiles failed rather than completed', async () => {
  const old = process.env.AWFL_NATIVE_PROFILE_ENABLED;
  process.env.AWFL_NATIVE_PROFILE_ENABLED = '1';
  const errors = [], infos = [];
  const oldError = console.error, oldInfo = console.info;
  console.error = value => errors.push(value);
  console.info = value => infos.push(value);
  try {
    const id = 'native_' + 'f'.repeat(32);
    const app = appFor({ store: {}, releases: {}, handlers: {},
      execute: async () => ({ status: 'failed', error: { code: null, message: 'missing field or element: arg1' } }),
    });
    const response = await request(app).post('/native/execute').send({ executionId: id });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { state: 'FAILED' });
    assert.deepEqual(JSON.parse(errors[0]), { event: 'awfl_native_execution_failed',
      executionId: id, projectId: 'project-a', executionMode: 'durable',
      storageBackend: 'firestore', errorCode: null,
      errorMessage: 'missing field or element: arg1' });
    const timing = infos.map(line => JSON.parse(line)).find(line => line.event === 'awfl_native_job_timing');
    assert.equal(timing.outcome, 'failed');
  } finally {
    console.error = oldError; console.info = oldInfo;
    if (old === undefined) delete process.env.AWFL_NATIVE_PROFILE_ENABLED;
    else process.env.AWFL_NATIVE_PROFILE_ENABLED = old;
  }
});


test('hybrid Firestore recovery dispatches each persisted execution to its pinned mode', async () => {
  const durable = 'native_' + 'a'.repeat(32);
  const memory = 'native_' + 'b'.repeat(32);
  const states = new Map([
    [durable, { executionId: durable, userId: 'owner', projectId: 'project',
      asyncLaunch: true, status: 'ready', leaseUntil: 0 }],
    [memory, { executionId: memory, userId: 'owner', projectId: 'project',
      executionMode: 'memory', asyncLaunch: true, status: 'ready', leaseUntil: 0 }],
  ]);
  const store = { get: async id => states.get(id) ?? null,
    listPendingAsync: async () => [...states.values()] };
  const calls = [];
  let scheduler;
  scheduler = nativeHybridAsyncSchedulerFor({ store, releases: {}, handlers: {},
    executeDurable: async args => calls.push(['durable', args.executionId,
      args.asyncScheduler === scheduler]),
    executeMemory: async args => calls.push(['memory', args.executionId,
      args.asyncScheduler === scheduler]),
  });
  try {
    await scheduler.scan(); await scheduler.drain();
    assert.deepEqual(calls.sort((a, b) => a[1].localeCompare(b[1])), [
      ['durable', durable, true], ['memory', memory, true],
    ]);
  } finally { await scheduler.close(); }
});

test('hybrid recovery quarantines old untagged memory children instead of running durable', async () => {
  const child = 'native_' + 'c'.repeat(32);
  const parent = 'native_' + 'd'.repeat(32);
  const state = { executionId: child, userId: 'owner', projectId: 'project',
    detachedParentExecutionId: parent, asyncLaunch: true,
    status: 'ready', leaseUntil: 0 };
  const calls = [], diagnostics = [], oldError = console.error;
  console.error = line => diagnostics.push(JSON.parse(line));
  const scheduler = nativeHybridAsyncSchedulerFor({
    store: { get: async id => id === child ? state : { executionMode: 'memory' },
      listPendingAsync: async () => [state] },
    releases: {}, handlers: {},
    executeMemory: async () => calls.push('memory'),
    executeDurable: async () => calls.push('durable'),
  });
  try {
    await scheduler.scan(); await scheduler.drain();
    await scheduler.scan(); await scheduler.drain();
    assert.deepEqual(calls, []);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].event, 'awfl_native_legacy_detached_mode_missing');
    assert.equal(diagnostics[0].executionId, child);
    assert.equal(diagnostics[0].parentExecutionId, parent);
  } finally { await scheduler.close(); console.error = oldError; }
});


test('GKE Firestore recovery uses per-record hybrid mode even if worker memory flag is absent', async () => {
  const flags = ['AWFL_NATIVE_EXECUTION_ENABLED',
    'AWFL_NATIVE_DETACHED_GKE_ENABLED', 'AWFL_NATIVE_PERSISTENT_WORKER',
    'AWFL_NATIVE_MEMORY_EXECUTION_ENABLED', 'AWFL_NATIVE_DOCUMENT_STORE_ENABLED'];
  const before = Object.fromEntries(flags.map(key => [key, process.env[key]]));
  process.env.AWFL_NATIVE_EXECUTION_ENABLED = '1';
  process.env.AWFL_NATIVE_DETACHED_GKE_ENABLED = '1';
  process.env.AWFL_NATIVE_PERSISTENT_WORKER = '1';
  delete process.env.AWFL_NATIVE_MEMORY_EXECUTION_ENABLED;
  process.env.AWFL_NATIVE_DOCUMENT_STORE_ENABLED = '0';
  const store = { get: async () => null, listPendingAsync: async () => [] };
  let scheduler;
  try {
    scheduler = startNativeDetachedRecovery({ store, releases: {}, handlers: {} });
    assert.ok(scheduler);
    assert.equal(scheduler, nativeHybridAsyncSchedulerFor({
      store, releases: {}, handlers: {} }));
    await scheduler.scan();
  } finally {
    await scheduler?.close();
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
