import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeExecutionStore, tagNativeValue } from './executionStore.js';

function fakeFirestore() {
  const docs = new Map();
  return {
    collection: name => ({
      doc: key => ({ key: name + '/' + key, async get() {
        const value = docs.get(this.key);
        return { exists: value !== undefined, data: () => structuredClone(value) };
      } }),
      where(field, operator, expected) {
        assert.equal(operator, '==');
        return {
          limit(max) { return { async get() {
            const rows = [...docs.entries()]
              .filter(([key, data]) =>
                key.startsWith(name + '/') &&
                !key.slice(name.length + 1).includes('/') &&
                data[field] === expected)
              .slice(0, max).map(([key, data]) => ({
                id: key.slice(name.length + 1), data: () => structuredClone(data),
              }));
            return { docs: rows };
          } }; },
        };
      },
    }),
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
const hash = 'a'.repeat(64);
const setup = async () => {
  let now = 1000;
  const store = new NativeExecutionStore({ db: fakeFirestore(), clock: () => now });
  await store.create({ executionId: 'e1', userId: 'u', projectId: 'p', artifactSha256: hash, input: { type: 'null' } });
  return { store, advance: delta => { now += delta; } };
};

test('claims fence old workers after lease expiry and preserve checkpoint', async () => {
  const { store, advance } = await setup();
  const a = await store.claim({ executionId: 'e1', workerId: 'a', leaseMs: 1000 });
  await store.checkpoint({ executionId: 'e1', workerId: 'a', epoch: a.epoch, nodeId: '0_1', slots: { s0: { type: 'integer', value: 7 } } });
  await assert.rejects(store.claim({ executionId: 'e1', workerId: 'b' }), /lease held/);
  advance(1000);
  const b = await store.claim({ executionId: 'e1', workerId: 'b' });
  assert.equal(b.epoch, a.epoch + 1);
  assert.equal(b.checkpoint.slots.s0.value, 7);
  await assert.rejects(store.checkpoint({ executionId: 'e1', workerId: 'a', epoch: a.epoch, nodeId: '0_2', slots: {} }), /stale worker/);
});

test('prepare before effects; replay same intent, record once and reject different outcomes', async () => {
  const { store } = await setup();
  const { epoch } = await store.claim({ executionId: 'e1', workerId: 'a' });
  const args = { url: 'https://example.test' };
  const intent = { executionId: 'e1', workerId: 'a', epoch, nodeId: '0_1', effectId: 'effect_1', operation: 'http.post', args, slots: {} };
  await store.prepareEffect(intent);
  await store.prepareEffect(intent);
  await assert.rejects(store.checkpoint({ executionId: 'e1', workerId: 'a', epoch, nodeId: '0_2', slots: {} }), /effect pending/);
  await assert.rejects(store.prepareEffect({ ...intent, args: { url: 'other' } }), /different effect/);
  await assert.rejects(store.complete({ executionId: 'e1', workerId: 'a', epoch, result: 1 }), /unresolved/);
  const result = { status: 200 };
  await store.recordEffect({ executionId: 'e1', workerId: 'a', epoch, effectId: 'effect_1', outcome: result });
  await store.recordEffect({ executionId: 'e1', workerId: 'a', epoch, effectId: 'effect_1', outcome: result });
  await assert.rejects(store.recordEffect({ executionId: 'e1', workerId: 'a', epoch, effectId: 'effect_1', outcome: { status: 500 } }), /differs/);
  await store.prepareEffect(intent);
  const state = await store.get('e1');
  assert.equal(state.pendingEffect, null);
  assert.equal(state.effectCount, 1);
  assert.deepEqual((await store.getEffect('e1', 'effect_1')).outcome, result);
  await store.complete({ executionId: 'e1', workerId: 'a', epoch, result: { done: true } });
  assert.deepEqual((await store.claim({ executionId: 'e1', workerId: 'b' })).result, { done: true });
});

test('crash after intent leaves pending effect for recovery; no implicit reexecution', async () => {
  const { store, advance } = await setup();
  const a = await store.claim({ executionId: 'e1', workerId: 'a', leaseMs: 1000 });
  await store.prepareEffect({ executionId: 'e1', workerId: 'a', epoch: a.epoch, nodeId: '0_3', effectId: 'effect_1', operation: 'http.post', args: {}, slots: { s0: 3 } });
  advance(1000);
  const b = await store.claim({ executionId: 'e1', workerId: 'b' });
  assert.equal(b.status, 'waiting_effect');
  assert.equal(b.pendingEffect.effectId, 'effect_1');
  assert.deepEqual(b.checkpoint.slots, { s0: 3 });
  await assert.rejects(store.recordEffect({ executionId: 'e1', workerId: 'a', epoch: a.epoch, effectId: 'effect_1', outcome: {} }), /stale worker/);
  await store.recordEffect({ executionId: 'e1', workerId: 'b', epoch: b.epoch, effectId: 'effect_1', outcome: { reconciled: true } });
  assert.equal((await store.get('e1')).status, 'ready');
});

test('reject invalid identifiers, missing data, and duplicate execution', async () => {
  const { store } = await setup();
  await assert.rejects(store.create({ executionId: 'e1', userId: 'u', projectId: 'p', artifactSha256: hash, input: null }), /already exists/);
  await assert.rejects(store.claim({ executionId: 'bad/path', workerId: 'a' }), /invalid/);
  await assert.rejects(store.create({ executionId: 'e2', userId: 'u', projectId: 'p', artifactSha256: 'no', input: null }), /SHA-256/);
});


test('lease renewal extends ownership and cancellation fences active workers', async () => {
  const { store, advance } = await setup();
  const a = await store.claim({ executionId: 'e1', workerId: 'a', leaseMs: 1000 });
  advance(500);
  const renewed = await store.renew({ executionId: 'e1', workerId: 'a', epoch: a.epoch, leaseMs: 2000 });
  assert.equal(renewed.leaseUntil, 3500);
  advance(600);
  await assert.rejects(store.claim({ executionId: 'e1', workerId: 'b' }), /lease held/);
  await assert.rejects(store.cancel({ executionId: 'e1', userId: 'intruder', projectId: 'p' }), /owner mismatch/);
  const cancelled = await store.cancel({ executionId: 'e1', userId: 'u', projectId: 'p' });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await store.claim({ executionId: 'e1', workerId: 'b' })).cancelled, true);
  await assert.rejects(store.checkpoint({ executionId: 'e1', workerId: 'a', epoch: a.epoch, nodeId: '0_1', slots: {} }), /stale worker/);
});

test('effect journal is a subcollection and does not grow the execution document', async () => {
  const { store } = await setup();
  const { epoch } = await store.claim({ executionId: 'e1', workerId: 'a' });
  for (let index = 0; index < 40; index++) {
    const effectId = 'call_' + index;
    await store.prepareEffect({ executionId: 'e1', workerId: 'a', epoch,
      nodeId: '0.' + index, effectId, operation: 'http.get',
      args: { index }, slots: {} });
    await store.recordEffect({ executionId: 'e1', workerId: 'a', epoch,
      effectId, outcome: { index } });
  }
  const state = await store.get('e1');
  assert.equal(state.effectCount, 40);
  assert.equal(Object.hasOwn(state, 'effectResults'), false);
  assert.equal(state.pendingEffect, null);
  assert.deepEqual((await store.getEffect('e1', 'call_39')).outcome, { index: 39 });
  assert.deepEqual((await store.getEffect('e1', 'call_0')).outcome, { index: 0 });
});

test('deeply nested Rust continuation values store as JSON without exceeding Firestore map depth', async () => {
  const db = fakeFirestore();
  const store = new NativeExecutionStore({ db, clock: () => 1000 });
  await store.create({ executionId: 'deep', userId: 'u', projectId: 'p',
    artifactSha256: hash, input: {}, protocolVersion: 2 });
  const { epoch } = await store.claim({ executionId: 'deep', workerId: 'a' });
  const intent = {
    executionId: 'deep', workerId: 'a', epoch,
    effectId: 'call_0', nodeId: '0.0', operation: 'http.get',
    args: {}, slots: {}, protocolVersion: 2,
    continuation: { next_step: 1, frames: [], slots: {} }, resultSlot: 's1',
  };
  await store.prepareEffect(intent);
  let outcome = 'deep value';
  for (let i = 0; i < 28; i++) outcome = { nested: outcome };
  await store.recordEffect({ executionId: 'deep', workerId: 'a', epoch,
    effectId: 'call_0', outcome });
  const raw = (await db.collection('nativeWorkflowExecutions').doc('deep').get()).data();
  assert.equal(raw.checkpoint, null);
  assert.equal(typeof raw.checkpointJson, 'string');
  assert.equal(raw.input, null);
  const checkpoint = JSON.parse(raw.checkpointJson);
  assert.deepEqual(checkpoint.slots.s1, tagNativeValue(outcome));
  assert.deepEqual((await store.get('deep')).checkpoint, checkpoint);
  assert.deepEqual((await store.claim({ executionId: 'deep', workerId: 'a' })).checkpoint, checkpoint);
  await store.checkpoint({ executionId: 'deep', workerId: 'a', epoch,
    nodeId: '0.1', slots: checkpoint.slots });
  assert.deepEqual((await store.get('deep')).checkpoint.slots, checkpoint.slots);
});

test('size limits reject large input and effects before persistence', async () => {
  const { store } = await setup();
  await assert.rejects(store.create({ executionId: 'e2', userId: 'u',
    projectId: 'p', artifactSha256: hash, input: 'x'.repeat(300000) }), /size limit/);
  const { epoch } = await store.claim({ executionId: 'e1', workerId: 'a' });
  const base = { executionId: 'e1', workerId: 'a', epoch,
    nodeId: '0.0', effectId: 'call_0', operation: 'http.post',
    args: {}, slots: {} };
  await assert.rejects(store.prepareEffect({ ...base,
    args: { payload: 'x'.repeat(150000) } }), /size limit/);
  await store.prepareEffect(base);
  await assert.rejects(store.recordEffect({ executionId: 'e1',
    workerId: 'a', epoch, effectId: 'call_0',
    outcome: { payload: 'x'.repeat(150000) } }), /size limit/);
  assert.equal((await store.get('e1')).pendingEffect.effectId, 'call_0');
  assert.equal(await store.getEffect('e1', 'call_0'), null);
});


test('confirmed remote error atomically records journal and resumes compiled catch', async () => {
  const { store } = await setup();
  const { epoch } = await store.claim({ executionId: 'e1', workerId: 'a' });
  const intent = { executionId: 'e1', workerId: 'a', epoch,
    nodeId: '0.1', effectId: 'call_1', operation: 'http.post', args: { url: 'https://example.test' },
    slots: { s1: { type: 'integer', value: 9 } },
    continuation: { next_step: 2, frames: [],
      slots: { s1: { type: 'integer', value: 9 } } },
    resultSlot: 's2', protocolVersion: 2,
    onError: { nextStep: 5, errorSlot: 's3' },
  };
  // Existing execution defaults to IPC v1; the new exception edge must
  // require a pinned v2 execution, not just a v2 caller argument.
  await assert.rejects(store.prepareEffect(intent), /differs/);
  const db = fakeFirestore();
  const newer = new NativeExecutionStore({ db, clock: () => 1000 });
  await newer.create({ executionId: 'e2', userId: 'u', projectId: 'p',
    artifactSha256: hash, input: {}, protocolVersion: 2 });
  const claimed = await newer.claim({ executionId: 'e2', workerId: 'a' });
  const request = { ...intent, executionId: 'e2', epoch: claimed.epoch };
  await newer.prepareEffect(request);
  await assert.rejects(newer.prepareEffect({ ...request,
    onError: { nextStep: -1, errorSlot: 's3' } }), /error edge/);
  const failure = { message: 'HTTP 503', code: 503 };
  await newer.recordEffectFailure({ executionId: 'e2', workerId: 'a', epoch: claimed.epoch,
    effectId: 'call_1', failure });
  await newer.recordEffectFailure({ executionId: 'e2', workerId: 'a', epoch: claimed.epoch,
    effectId: 'call_1', failure });
  const state = await newer.get('e2');
  assert.equal(state.status, 'ready');
  assert.equal(state.pendingEffect, null);
  assert.equal(state.checkpoint.next_step, 5);
  assert.equal(state.checkpoint.slots.s1.value, 9);
  assert.deepEqual(state.checkpoint.slots.s3, {
    type: 'map', value: {
      message: { type: 'string', value: 'HTTP 503' },
      code: { type: 'integer', value: 503 },
    },
  });
  assert.equal(state.effectCount, 1);
  assert.equal((await newer.getEffect('e2', 'call_1')).isError, true);
  await assert.rejects(newer.recordEffect({ executionId: 'e2', workerId: 'a',
    epoch: claimed.epoch, effectId: 'call_1', outcome: failure }), /differs/);
  await assert.rejects(newer.recordEffectFailure({ executionId: 'e2', workerId: 'a',
    epoch: claimed.epoch, effectId: 'call_1', failure: { message: 'HTTP 401', code: 401 } }), /differs/);
  await newer.complete({ executionId: 'e2', workerId: 'a', epoch: claimed.epoch,
    result: 'recovered' });
  assert.equal((await newer.get('e2')).result, 'recovered');
});

test('uncaught native Raise ends with durable failed status and no redispatch', async () => {
  const { store } = await setup();
  const { epoch } = await store.claim({ executionId: 'e1', workerId: 'a' });
  const error = { message: 'explicitly raised', code: null };
  await store.fail({ executionId: 'e1', workerId: 'a', epoch, error });
  const state = await store.get('e1');
  assert.equal(state.status, 'failed');
  assert.deepEqual(state.error, error);
  assert.deepEqual(await store.claim({ executionId: 'e1', workerId: 'b' }),
    { failed: true, error });
  await assert.rejects(store.cancel({ executionId: 'e1', userId: 'u', projectId: 'p' }), /already failed/);
  await assert.rejects(store.complete({ executionId: 'e1', workerId: 'a', epoch,
    result: {} }), /stale worker|terminal/);
});

test('native fork lane state pins deterministic identity and rejects changed snapshots', async () => {
  const store = new NativeExecutionStore({ db: fakeFirestore(), clock: () => 1000 });
  const parentId = 'native_' + 'f'.repeat(32);
  const nodeId = '0.2', generation = 'fork_0_2_0', index = 3;
  await store.create({
    executionId: parentId, userId: 'owner', projectId: 'tenant',
    artifactSha256: hash, input: { a: 1 }, protocolVersion: 2,
    workflowName: 'Workflow', parallelVersion: 1,
    allowedOperations: ['http.post', 'native.parallel'],
  });
  const { epoch } = await store.claim({ executionId: parentId, workerId: 'parent' });
  await store.prepareEffect({
    executionId: parentId, workerId: 'parent', epoch, nodeId, effectId: generation,
    operation: 'native.parallel', args: { generation, lanes: [] }, slots: {},
    protocolVersion: 2,
  });
  const input = { a: 1 };
  const slots = { s0: { type: 'integer', value: 4 } };
  const entry = 'pc_3';
  const { forkLaneId } = await import('./forkCoordinator.js');
  const { createHash } = await import('node:crypto');
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const executionId = forkLaneId({ parentExecutionId: parentId, nodeId, generation, index });
  const forkLane = {
    parentExecutionId: parentId, rootExecutionId: parentId, depth: 1,
    nodeId, generation, index, entry, slots,
    snapshotSha256: digest({ input, slots, entry }),
  };
  const create = { executionId, userId: 'owner', projectId: 'tenant', artifactSha256: hash,
    input, protocolVersion: 2, parallelVersion: 1, workflowName: 'Workflow',
    allowedOperations: ['http.post', 'native.parallel'], forkLane };
  await store.create(create);
  const persisted = await store.get(executionId);
  assert.deepEqual(persisted.forkLane, forkLane);
  assert.equal(persisted.parallelVersion, 1);
  assert.equal(persisted.input.a, 1);
  await assert.rejects(store.create({ ...create, executionId: 'native_' + 'a'.repeat(32) }), /deterministic identity/);
  await assert.rejects(store.create({ ...create, forkLane: { ...forkLane, slots: { s0: { type: 'integer', value: 5 } } } }), /digest/);
  await assert.rejects(store.create({ ...create, parallelVersion: undefined }), /parallel operation requires a pinned/);
  await assert.rejects(store.create({ ...create, forkLane: { ...forkLane, entry: '../../injected' } }), /invalid native fork lane metadata/);
  const child = await store.claim({ executionId, workerId: 'child' });
  await store.cancel({ executionId: parentId, userId: 'owner', projectId: 'tenant' });
  await assert.rejects(store.claim({ executionId, workerId: 'replacement' }), /parent is no longer active/);
  await assert.rejects(store.checkpoint({
    executionId, workerId: 'child', epoch: child.epoch, nodeId: '0.2', slots: {},
  }), /parent is no longer active/);
  const nextLane = { ...forkLane, index: 4 };
  await assert.rejects(store.create({ ...create,
    executionId: forkLaneId({ parentExecutionId: parentId, nodeId, generation, index: 4 }),
    forkLane: nextLane,
  }), /parent is no longer active/);
});

test('confirmed parallel branch failure takes the compiled Try edge with null code', async () => {
  const store = new NativeExecutionStore({ db: fakeFirestore(), clock: () => 1000 });
  const executionId = 'native_' + 'd'.repeat(32);
  await store.create({
    executionId, userId: 'verified', projectId: 'tenant',
    workflowName: 'ParallelFailureTest', input: {},
    artifactSha256: hash, protocolVersion: 2, parallelVersion: 1,
    allowedOperations: ['native.parallel'],
  });
  const { epoch } = await store.claim({ executionId, workerId: 'w' });
  await store.prepareEffect({
    executionId, workerId: 'w', epoch, nodeId: '0.0',
    effectId: 'fork_0_0', operation: 'native.parallel',
    args: { generation: 'fork_0_0', lanes: [] },
    slots: {}, continuation: { next_step: 1, slots: {}, frames: [] },
    resultSlot: 's0', protocolVersion: 2,
    onError: { nextStep: 7, errorSlot: 's1' },
  });
  const failure = { message: 'branch raised', code: null };
  await store.recordEffectFailure({
    executionId, workerId: 'w', epoch, effectId: 'fork_0_0', failure,
  });
  const state = await store.get(executionId);
  assert.equal(state.status, 'ready');
  assert.equal(state.checkpoint.next_step, 7);
  assert.equal(state.pendingEffect, null);
  assert.deepEqual(state.checkpoint.slots.s1, {
    type: 'map', value: {
      message: { type: 'string', value: 'branch raised' },
      code: { type: 'null' },
    },
  });
  const journal = await store.getEffect(executionId, 'fork_0_0');
  assert.equal(journal.isError, true);
  assert.deepEqual(journal.outcome, failure);
});

test('uncaught confirmed parallel failure commits parent terminal state and journal atomically', async () => {
  const store = new NativeExecutionStore({ db: fakeFirestore() });
  const executionId = 'native_' + 'b'.repeat(32);
  await store.create({
    executionId, userId: 'verified', projectId: 'tenant',
    workflowName: 'ParallelFailureTest', input: {},
    artifactSha256: hash, protocolVersion: 2, parallelVersion: 1,
    allowedOperations: ['native.parallel'],
  });
  const { epoch } = await store.claim({ executionId, workerId: 'w' });
  await store.prepareEffect({
    executionId, workerId: 'w', epoch, nodeId: '0.0',
    effectId: 'fork_0_0', operation: 'native.parallel',
    args: { generation: 'fork_0_0', lanes: [] },
    slots: {}, continuation: { next_step: 1, slots: {}, frames: [] },
    resultSlot: 's0', protocolVersion: 2,
  });
  const failure = { message: 'uncaught branch Raise', code: null };
  await store.failPendingParallel({
    executionId, workerId: 'w', epoch, effectId: 'fork_0_0', error: failure,
  });
  const state = await store.get(executionId);
  assert.equal(state.status, 'failed');
  assert.deepEqual(state.error, failure);
  assert.equal(state.pendingEffect, null);
  assert.equal(state.effectCount, 1);
  assert.deepEqual((await store.getEffect(executionId, 'fork_0_0')).outcome, failure);
  assert.deepEqual(await store.claim({ executionId, workerId: 'retry' }), {
    failed: true, error: failure,
  });
});

test('detached execution has a pinned durable record and clears recovery marker on completion', async () => {
  const db = fakeFirestore();
  const store = new NativeExecutionStore({ db });
  const asyncId = 'native_' + 'e'.repeat(32);
  await store.create({ executionId: asyncId, userId: 'u', projectId: 'p',
    artifactSha256: hash, protocolVersion: 2, input: { query: 'continue' },
    workflowName: 'codebase-ProjectManager', allowedOperations: ['native.parallel'],
    parallelVersion: 1, trustedGlobalsVersion: 1, asyncLaunch: true });
  const pending = await store.get(asyncId);
  assert.equal(pending.status, 'ready');
  assert.equal(pending.asyncLaunch, true);
  assert.deepEqual(pending.input, { query: 'continue' });
  assert.deepEqual((await store.listPendingAsync()).map(x => x.executionId), [asyncId]);
  const claimed = await store.claim({ executionId: asyncId, workerId: 'worker_async' });
  await store.complete({ executionId: asyncId, workerId: 'worker_async',
    epoch: claimed.epoch, result: { done: true } });
  const finished = await store.get(asyncId);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.asyncLaunch, false);
  assert.deepEqual(finished.result, { done: true });
  assert.deepEqual(await store.listPendingAsync(), []);
  await assert.rejects(store.listPendingAsync(0), /scan limit/);
  await assert.rejects(store.create({ executionId: 'native_' + 'd'.repeat(32),
    userId: 'u', projectId: 'p', artifactSha256: hash,
    input: {}, asyncLaunch: true, protocolVersion: 1 }), /standalone protocol-v2/);
});

test('streaming IPC capability remains pinned across claims and recovery', async () => {
  const store = new NativeExecutionStore({ db: fakeFirestore(), clock: () => 1000 });
  const executionId = 'native_' + 'e'.repeat(32);
  await store.create({ executionId, userId:'u', projectId:'p', artifactSha256:hash,
    workflowName:'Example', protocolVersion:2, input:{ value:1 },
    allowedOperations:['http.post'], streamIpcVersion:1 });
  const saved = await store.get(executionId);
  assert.equal(saved.streamIpcVersion,1);
  assert.equal((await store.claim({ executionId, workerId:'w1' })).streamIpcVersion,1);
  await assert.rejects(store.create({
    executionId:'native_'+'d'.repeat(32),userId:'u',projectId:'p',
    artifactSha256:hash, protocolVersion:1, input:{}, streamIpcVersion:1,
  }),/invalid pinned native stream IPC version/);
  await assert.rejects(store.create({
    executionId:'native_'+'d'.repeat(32),userId:'u',projectId:'p',
    artifactSha256:hash, protocolVersion:2, input:{}, streamIpcVersion:2,
  }),/invalid pinned native stream IPC version/);
});


test('confirmed workflow.run child failure commits terminal status, clears lease and prevents retry', async () => {
  const store = new NativeExecutionStore({ db: fakeFirestore() });
  const executionId = 'native_' + 'd'.repeat(32);
  await store.create({
    executionId, userId: 'owner', projectId: 'project',
    workflowName: 'ParentWithChild', input: {}, artifactSha256: hash,
    protocolVersion: 2, allowedOperations: ['workflow.run'],
  });
  const { epoch } = await store.claim({ executionId, workerId: 'first' });
  await store.prepareEffect({
    executionId, workerId: 'first', epoch, nodeId: '0.0',
    effectId: 'child_effect', operation: 'workflow.run',
    args: { workflow_id: 'Child', argument: {} },
    slots: {}, continuation: { next_step: 1, slots: {}, frames: [] },
    resultSlot: 's0', protocolVersion: 2,
  });
  const error = { message: 'missing field or element: workdir', code: null };
  await store.failPendingConfirmedEffect({
    executionId, workerId: 'first', epoch, effectId: 'child_effect',
    operation: 'workflow.run', error,
  });
  const failed = await store.get(executionId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.owner, null);
  assert.equal(failed.leaseUntil, 0);
  assert.equal(failed.pendingEffect, null);
  assert.deepEqual(failed.error, error);
  assert.deepEqual((await store.getEffect(executionId, 'child_effect')).outcome, error);
  assert.deepEqual(await store.claim({ executionId, workerId: 'retry' }), {
    failed: true, error,
  });
});

test('confirmed workflow.run error can resume at compiled catch edge', async () => {
  const store = new NativeExecutionStore({ db: fakeFirestore() });
  const executionId = 'native_' + 'c'.repeat(32);
  await store.create({
    executionId, userId: 'owner', projectId: 'project',
    workflowName: 'ParentWithCatch', input: {}, artifactSha256: hash,
    protocolVersion: 2, allowedOperations: ['workflow.run'],
  });
  const { epoch } = await store.claim({ executionId, workerId: 'first' });
  await store.prepareEffect({
    executionId, workerId: 'first', epoch, nodeId: '0.0',
    effectId: 'child_effect', operation: 'workflow.run',
    args: { workflow_id: 'Child', argument: {} },
    slots: {}, continuation: { next_step: 1, slots: {}, frames: [] },
    resultSlot: 's0', protocolVersion: 2,
    onError: { nextStep: 7, errorSlot: 's1' },
  });
  const failure = { message: 'child raised', code: null };
  await store.recordEffectFailure({
    executionId, workerId: 'first', epoch, effectId: 'child_effect', failure,
  });
  const resumed = await store.get(executionId);
  assert.equal(resumed.status, 'ready');
  assert.equal(resumed.checkpoint.next_step, 7);
  assert.equal(resumed.pendingEffect, null);
  assert.deepEqual((await store.getEffect(executionId, 'child_effect')).outcome, failure);
});
