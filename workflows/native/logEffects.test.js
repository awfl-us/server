import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeLogEffectHandler } from './logEffects.js';
import { NativeEffectDispatcher } from './effectDispatcher.js';

const identity = Object.freeze({ userId: 'verified-user', projectId: 'verified-project' });
const request = (args = { text: '[logError] attempted operation failed' }) => ({
  args, identity, idempotencyKey: 'native_123:call_0_except_0',
});

test('authenticated sys.log emits bounded structured log with stable insertId', async () => {
  const events = [];
  const handler = createNativeLogEffectHandler({ info: event => events.push(event) });
  assert.equal(await handler(request()), null);
  assert.deepEqual(events, [{
    severity: 'INFO',
    message: '[logError] attempted operation failed',
    'logging.googleapis.com/insertId': 'native_123:call_0_except_0',
    nativeWorkflow: identity,
  }]);
});

test('nested native child log effects accept the runner-generated scoped idempotency key', async () => {
  const entries = [];
  const handler = createNativeLogEffectHandler({ info: record => entries.push(record) });
  const id = 'native_' + 'f'.repeat(32) +
    ':root:1:2:call_0_0_except_0';
  assert.equal(await handler({ ...request({ text: 'nested child failed' }),
    idempotencyKey: id }), null);
  assert.deepEqual(entries.map(entry => entry['logging.googleapis.com/insertId']), [id]);
  await assert.rejects(handler({ ...request(),
    idempotencyKey: id + ':!' }), /invalid authenticated native log effect/);
  await assert.rejects(handler({ ...request(),
    idempotencyKey: 'native_abc:root::call1' }), /invalid authenticated native log effect/);
  await assert.rejects(handler({ ...request(),
    idempotencyKey: id + ':extra'.repeat(300) }), /invalid authenticated native log effect/);
});

test('log handler rejects malformed untrusted input without emitting or network calls', async () => {
  const events = [];
  const handler = createNativeLogEffectHandler({ info: value => events.push(value) });
  assert.throws(() => createNativeLogEffectHandler({}), /logger/);
  const invalid = [
    null, [], {}, { text: 123 }, { text: '' },
    { text: 'x'.repeat(4097) }, { text: 'é'.repeat(2500) },
    { text: 'allowed', url: 'https://attacker.example.org' },
    Object.assign(Object.create(null), { text: 'not plain object' }),
  ];
  for (const args of invalid) {
    await assert.rejects(handler(request(args)), /invalid authenticated native log effect/);
  }
  for (const values of [
    { identity: { userId: 'a', projectId: '' } },
    { identity: { userId: '', projectId: 'p' } },
    { identity: undefined },
    { idempotencyKey: 'bad key!' },
    { idempotencyKey: '' },
  ]) await assert.rejects(handler({ ...request(), ...values }), /invalid authenticated native log effect/);
  assert.equal(events.length, 0);
});

test('native effect dispatcher journals canonical log.write and checks lease and tenant', async () => {
  const logged = [], recorded = [];
  const handler = createNativeLogEffectHandler({ info: value => logged.push(value) });
  const state = {
    owner: 'worker', epoch: 1, leaseUntil: Date.now() + 60_000,
    userId: identity.userId, projectId: identity.projectId, updatedAt: 1,
    pendingEffect: {
      effectId: 'call1', operation: 'log.write',
      args: { text: '[logError] captured' }, fingerprint: 'hash', preparedAt: 1,
    },
  };
  const store = {
    get: async () => structuredClone(state),
    recordEffect: async value => recorded.push(value),
  };
  const dispatcher = new NativeEffectDispatcher({
    handlers: { 'log.write': handler },
    authorizeExecution: async ({ userId, projectId }) => ({ allowed: true, userId, projectId }),
  });
  const options = { store, executionId: 'native_abc', workerId: 'worker', epoch: 1, effectId: 'call1' };
  const outcome = await dispatcher.dispatch(options);
  assert.deepEqual(outcome, { status: 'recorded', effectId: 'call1', outcome: null });
  assert.equal(logged.length, 1);
  assert.equal(logged[0]['logging.googleapis.com/insertId'], 'native_abc:call1');
  assert.deepEqual(recorded[0], { executionId: 'native_abc', workerId: 'worker', epoch: 1, effectId: 'call1', outcome: null });
  // Old owner cannot log after an epoch takeover or cancellation.
  state.epoch = 2;
  await assert.rejects(dispatcher.dispatch(options), /worker lease invalid/);
  assert.equal(logged.length, 1);
  assert.equal(recorded.length, 1);
  // Authorization denial rejects before reaching logger.
  state.epoch = 1;
  const denied = new NativeEffectDispatcher({
    handlers: { 'log.write': handler },
    authorizeExecution: async () => ({ allowed: false, ...identity }),
  });
  await assert.rejects(denied.dispatch(options), /not authorized/);
  assert.equal(logged.length, 1);
});


test('detached log recovery re-emits with stable insertId and journals the outcome', async () => {
  const entries = [], recorded = [];
  const handler = createNativeLogEffectHandler({ info: value => entries.push(value) });
  const state = {
    owner: 'replacement-worker', epoch: 2,
    leaseUntil: Date.now() + 60_000, updatedAt: 20,
    userId: identity.userId, projectId: identity.projectId,
    pendingEffect: { effectId: 'call8', operation: 'log.write',
      fingerprint: 'saved-fingerprint', preparedAt: 10,
      args: { text: '[logTool] persistent native tool schema' } },
  };
  const store = {
    get: async () => structuredClone(state),
    recordEffect: async args => { recorded.push(args); return { ...state, status: 'ready' }; },
  };
  // The production worker explicitly registers its local structured-log
  // handler as a safe reconciler; external HTTP operations remain excluded.
  const dispatcher = new NativeEffectDispatcher({
    handlers: { 'log.write': handler },
    reconcile: { 'log.write': handler },
    authorizeExecution: async ({ userId, projectId }) =>
      ({ allowed: true, userId, projectId }),
  });
  const result = await dispatcher.dispatch({
    store, executionId: 'native_abc', workerId: state.owner,
    epoch: state.epoch, effectId: 'call8',
  });
  assert.equal(result.status, 'reconciled');
  assert.equal(result.outcome, null);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]['logging.googleapis.com/insertId'], 'native_abc:call8');
  assert.deepEqual(recorded.map(({ outcome, effectId }) => ({ outcome, effectId })),
    [{ outcome: null, effectId: 'call8' }]);
});

test('detached log recovery never bypasses cancellation or ownership fencing', async () => {
  let emissions = 0;
  const handler = createNativeLogEffectHandler({ info: () => { emissions++; } });
  const state = {
    owner: 'worker2', epoch: 2, leaseUntil: Date.now() + 60_000,
    updatedAt: 20, userId: identity.userId, projectId: identity.projectId,
    status: 'cancelled', pendingEffect: {
      effectId: 'call8', operation: 'log.write', fingerprint: 'f',
      preparedAt: 10, args: { text: 'before cancellation' },
    },
  };
  const dispatcher = new NativeEffectDispatcher({
    handlers: { 'log.write': handler }, reconcile: { 'log.write': handler },
    authorizeExecution: async ({ userId, projectId }) =>
      ({ allowed: true, userId, projectId }),
  });
  await assert.rejects(dispatcher.dispatch({
    store: { get: async () => state, recordEffect: async () => { throw Error('journaled'); } },
    executionId: 'native_abc', workerId: 'worker2', epoch: 2, effectId: 'call8',
  }), /changed during authorization/);
  assert.equal(emissions, 0);
});

// The optional native binary is generated by the Scala compiler from the
// unchanged public Try overload, which inserts sys.log before re-raising.
// This tests the Rust ↔ Node persistence boundary, without a network call.
const nativeLogBinary = process.env.AWFL_NATIVE_LOG_ERROR_BINARY;
function memoryFirestore() {
  const docs = new Map();
  return {
    collection: name => ({ doc: key => ({ key: `${name}/${key}`, async get() {
      const data = docs.get(this.key);
      return { exists: data !== undefined, data: () => structuredClone(data) };
    } }) }),
    async runTransaction(fn) {
      const writes = [];
      const tx = {
        get: ref => ref.get(),
        create: (ref, data) => writes.push([ref.key, structuredClone(data)]),
        update: (ref, data) => writes.push([ref.key, structuredClone(data)]),
      };
      const value = await fn(tx);
      for (const [key, data] of writes) docs.set(key, data);
      return value;
    },
  };
}

test('real compiled original DSL Try logs once, journals null, and re-raises terminal failure', {
  skip: !nativeLogBinary, timeout: 120_000,
}, async () => {
  const { createHash } = await import('node:crypto');
  const { readFile } = await import('node:fs/promises');
  const { NativeExecutionStore } = await import('./executionStore.js');
  const { runNativeWorkflow } = await import('./worker.js');
  const sha256 = createHash('sha256').update(await readFile(nativeLogBinary)).digest('hex');
  const executionId = 'native_' + 'c'.repeat(32);
  const store = new NativeExecutionStore({ db: memoryFirestore(), clock: () => Date.now() });
  await store.create({ executionId, ...identity, artifactSha256: sha256,
    workflowName: 'LogOnError', protocolVersion: 2, input: null,
    allowedOperations: ['log.write'] });
  let loaded = 0;
  const releases = { materialize: async () => {
    loaded++;
    return { executable: nativeLogBinary, sha256, cleanup: async () => {} };
  } };
  const logs = [];
  const handlers = { 'log.write': createNativeLogEffectHandler({ info: value => logs.push(value) }) };
  const original = await runNativeWorkflow({
    store, releases, executionId, ...identity, workerId: 'worker1', handlers,
  });
  assert.deepEqual(original, { status: 'failed', error: {
    message: 'deliberately raised', code: null,
  } });
  const state = await store.get(executionId);
  assert.equal(state.status, 'failed');
  assert.equal(state.effectCount, 1);
  assert.equal(state.pendingEffect, null);
  const journal = await store.getEffect(executionId, 'call_0_0_except_0');
  assert.equal(journal.outcome, null);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].message, '[logError] deliberately raised');
  assert.equal(logs[0]['logging.googleapis.com/insertId'],
    `${executionId}:call_0_0_except_0`);
  assert.deepEqual(logs[0].nativeWorkflow, identity);
  assert.equal(loaded, 1);
  const replay = await runNativeWorkflow({
    store, releases, executionId, ...identity, workerId: 'worker2',
    handlers: { 'log.write': async () => { throw new Error('no duplicate logging'); } },
  });
  assert.deepEqual(replay, original);
  assert.equal(logs.length, 1);
  assert.equal(loaded, 1);
  await assert.rejects(runNativeWorkflow({
    store, releases, executionId, userId: identity.userId,
    projectId: 'attacker', workerId: 'worker3', handlers,
  }), /does not match trusted Jobs task identity/);
});
