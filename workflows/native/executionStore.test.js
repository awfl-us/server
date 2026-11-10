import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeExecutionStore } from './executionStore.js';

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
