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
  assert.equal(Object.keys(state.effectResults).length, 1);
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
