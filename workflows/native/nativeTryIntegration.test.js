import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { NativeExecutionStore } from './executionStore.js';
import { NativeConfirmedHttpFailure } from './effectErrors.js';
import { createNativeLogEffectHandler } from './logEffects.js';
import { runNativeWorkflow } from './worker.js';
import { nativeExecutionStatus } from './executionApi.js';

// Uses the same Firestore transaction APIs as production, but isolated to
// memory. The *real compiled Rust executable* is staged by runNativeArtifact.
function fakeFirestore() {
  const docs = new Map();
  return {
    collection: name => ({ doc: key => ({ key: `${name}/${key}`, async get() {
      const value = docs.get(this.key);
      return { exists: value !== undefined, data: () => structuredClone(value) };
    } }) }),
    async runTransaction(fn) {
      const writes = [];
      const tx = {
        get: ref => ref.get(),
        create: (ref, data) => writes.push([ref.key, structuredClone(data)]),
        update: (ref, data) => writes.push([ref.key, structuredClone(data)]),
      };
      const result = await fn(tx);
      for (const [key, value] of writes) docs.set(key, value);
      return result;
    },
  };
}

const nativeBinary = process.env.AWFL_NATIVE_TRY_CATCH_BINARY;
const uncaughtBinary = process.env.AWFL_NATIVE_UNCAUGHT_BINARY;
const logBinary = process.env.AWFL_NATIVE_LOG_ERROR_BINARY;
const identity = { userId: 'verified-user', projectId: 'verified-project' };

async function setup(binary, marker, allowedOperations = ['http.post']) {
  const sha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  const store = new NativeExecutionStore({ db: fakeFirestore(), clock: () => Date.now() });
  const executionId = 'native_' + marker.repeat(32);
  await store.create({ executionId, ...identity, artifactSha256: sha256,
    workflowName: 'TryRaise', protocolVersion: 2, input: null,
    allowedOperations });
  let loaded = 0;
  const releases = { materialize: async () => {
    loaded++;
    return { executable: binary, sha256, cleanup: async () => {} };
  } };
  return { store, executionId, releases, getLoaded: () => loaded };
}

test('real Rust recoverable HTTP 503 atomically journals error and resumes catch', {
  skip: !nativeBinary, timeout: 120_000,
}, async () => {
  const f = await setup(nativeBinary, 'a');
  let attempts = 0;
  const result = await runNativeWorkflow({ ...f, ...identity, workerId: 'worker1',
    handlers: { 'http.post': async ({ identity: authorized }) => {
      attempts++;
      assert.deepEqual(authorized, identity);
      throw new NativeConfirmedHttpFailure(503);
    } },
  });
  assert.equal(result, 'HTTP 503');
  const state = await f.store.get(f.executionId);
  assert.equal(state.status, 'completed');
  assert.equal(state.effectCount, 1);
  assert.equal(attempts, 1);
  const journal = await f.store.getEffect(f.executionId, 'call_0_0_try_0');
  assert.equal(journal?.isError, true);
  assert.deepEqual(journal?.outcome, { message: 'HTTP 503', code: 503 });
  const reentered = await runNativeWorkflow({ ...f, ...identity,
    workerId: 'worker2', handlers: { 'http.post': async () => {
      throw new Error('must not redispatch completed error');
    } },
  });
  assert.equal(reentered, 'HTTP 503');
  assert.equal(attempts, 1);
  assert.equal(f.getLoaded(), 1);
  await assert.rejects(runNativeWorkflow({ ...f, ...identity,
    projectId: 'attacker', workerId: 'worker3', handlers: {},
  }), /does not match trusted Jobs task identity/);
});

test('uncaught native Raise persists Failed status, no rerun or cross-tenant leak', {
  skip: !uncaughtBinary, timeout: 120_000,
}, async () => {
  const f = await setup(uncaughtBinary, 'b');
  const result = await runNativeWorkflow({ ...f, ...identity, workerId: 'worker1',
    handlers: { 'http.post': () => { throw new Error('not called'); } },
  });
  assert.deepEqual(result, { status: 'failed', error: { message: 'uncaught', code: null } });
  const state = await f.store.get(f.executionId);
  assert.equal(state.status, 'failed');
  assert.deepEqual((await nativeExecutionStatus({db: f.store.db,
    execId: f.executionId, ...identity})).data.error, result.error);
  assert.equal(f.getLoaded(), 1);
  assert.deepEqual(await runNativeWorkflow({ ...f, ...identity, workerId: 'worker2',
    handlers: {} }), result);
  assert.equal(f.getLoaded(), 1);
  await assert.rejects(nativeExecutionStatus({ db: f.store.db,
    execId: f.executionId, userId: 'attacker', projectId: identity.projectId }),
    { code: 'NOT_FOUND' });
});


test('real original DSL Try logs once through journal then re-raises into terminal Failed', {
  skip: !logBinary, timeout: 120_000,
}, async () => {
  const f = await setup(logBinary, 'c', ['log.write']);
  const logged = [];
  const log = createNativeLogEffectHandler({ info: entry => logged.push(entry) });
  const handlers = { 'log.write': log };
  const result = await runNativeWorkflow({ ...f, ...identity, workerId: 'worker1', handlers });
  assert.deepEqual(result, { status: 'failed',
    error: { message: 'deliberately raised', code: null } });
  assert.equal(logged.length, 1, 'only one dispatch in successful execution');
  assert.deepEqual(logged[0], {
    severity: 'INFO',
    message: '[logError] deliberately raised',
    'logging.googleapis.com/insertId': `${f.executionId}:call_0_0_except_0`,
    nativeWorkflow: identity,
  });
  const journal = await f.store.getEffect(f.executionId, 'call_0_0_except_0');
  assert.equal(journal?.isError, undefined);
  assert.equal(journal?.outcome, null);
  const state = await f.store.get(f.executionId);
  assert.equal(state.status, 'failed');
  assert.equal(state.effectCount, 1);
  assert.equal(state.pendingEffect, null);
  assert.deepEqual(state.error, result.error);
  assert.deepEqual(await runNativeWorkflow({ ...f, ...identity, workerId: 'worker2',
    handlers: { 'log.write': () => { throw new Error('duplicate log dispatch'); } },
  }), result);
  assert.equal(logged.length, 1);
  assert.equal(f.getLoaded(), 1);
  await assert.rejects(runNativeWorkflow({ ...f, userId: 'other-user',
    workerId: 'worker3', handlers }), /does not match trusted Jobs task identity/);
  assert.equal(logged.length, 1);
});

test('crash after journaling log effect resumes without redispatching it', {
  skip: !logBinary, timeout: 120_000,
}, async () => {
  const f = await setup(logBinary, 'd', ['log.write']);
  const logged = [];
  const handlers = { 'log.write': createNativeLogEffectHandler({
    info: entry => logged.push(entry),
  }) };
  const originalFail = f.store.fail.bind(f.store);
  let interrupted = false;
  f.store.fail = async args => {
    if (!interrupted) {
      interrupted = true;
      throw new Error('simulated crash after effect journal commit');
    }
    return originalFail(args);
  };
  await assert.rejects(runNativeWorkflow({ ...f, ...identity,
    workerId: 'same-fenced-worker', handlers,
  }), /simulated crash after effect journal commit/);
  const before = await f.store.get(f.executionId);
  assert.equal(before.status, 'ready');
  assert.equal(before.effectCount, 1);
  assert.equal(logged.length, 1);
  const after = await runNativeWorkflow({ ...f, ...identity,
    workerId: 'same-fenced-worker', handlers: {
      'log.write': () => { throw new Error('must not redispatch journaled log'); },
    },
  });
  assert.deepEqual(after, { status: 'failed',
    error: { message: 'deliberately raised', code: null } });
  assert.equal(logged.length, 1);
  assert.equal((await f.store.get(f.executionId)).effectCount, 1);
});
