import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeExecutionStore } from './executionStore.js';
import { createDistributedExecutionBudget } from './distributedBudget.js';

function fakeFirestore() {
  const docs = new Map();
  let transactionTail = Promise.resolve();
  return {
    collection: name => ({ doc: key => ({ key: `${name}/${key}`, async get() {
      const value = docs.get(this.key);
      return { exists: value !== undefined, data: () => structuredClone(value) };
    } }) }),
    async runTransaction(fn) {
      // Model Firestore's serialized optimistic commits for overlapping
      // transactions; otherwise the fake can double-create a free slot.
      const previous = transactionTail;
      let finish;
      transactionTail = new Promise(resolve => { finish = resolve; });
      await previous;
      const writes = [];
      const tx = {
        get: ref => ref.get(),
        create: (ref, data) => writes.push([ref.key, structuredClone(data)]),
        update: (ref, data) => writes.push([ref.key, structuredClone(data)]),
      };
      try {
        const result = await fn(tx);
        for (const [key, value] of writes) docs.set(key, value);
        return result;
      } finally { finish(); }
    },
  };
}

const rootExecutionId = 'native_' + 'a'.repeat(32);
const base = { rootExecutionId, userId: 'trusted', projectId: 'tenant' };

async function fixture() {
  const db = fakeFirestore();
  let now = 1000;
  const makeStore = () => new NativeExecutionStore({ db, clock: () => now });
  const store = makeStore();
  await store.create({ executionId: rootExecutionId, userId: base.userId,
    projectId: base.projectId, workflowName: 'ParallelWork',
    artifactSha256: 'a'.repeat(64), input: null, protocolVersion: 2,
    parallelVersion: 1, allowedOperations: ['native.parallel'] });
  return { store, makeStore, advance: ms => { now += ms; }, time: () => now };
}

test('eight durable slots admit at most eight across distinct store instances', async () => {
  const { store, makeStore } = await fixture();
  const claimed = [];
  for (let slot = 0; slot < 8; slot++) {
    const lease = await (slot % 2 ? store : makeStore()).tryAcquirePermit({
      ...base, slot, permitId: `p${slot}`,
    });
    assert.equal(lease?.epoch, 1);
    claimed.push(lease);
  }
  for (let slot = 0; slot < 8; slot++) {
    assert.equal(await makeStore().tryAcquirePermit({
      ...base, slot, permitId: 'contender',
    }), null);
  }
  assert.equal(await makeStore().releasePermit({
    rootExecutionId, ...claimed[3],
  }), true);
  const reclaimed = await makeStore().tryAcquirePermit({
    ...base, slot: 3, permitId: 'afterRelease',
  });
  assert.equal(reclaimed?.epoch, 2);
  assert.equal(await store.releasePermit({ rootExecutionId, ...claimed[3] }), false);
  assert.equal(await store.renewPermit({ ...base, ...claimed[3] }).then(() => true,
    () => false), false);
  assert.ok(await store.renewPermit({ ...base, ...reclaimed }) > 1000);
  assert.equal(await store.releasePermit({ rootExecutionId, ...reclaimed }), true);
});

test('dead process permits expire; new owner fences stale renewal and release', async () => {
  const { store, makeStore, advance } = await fixture();
  const crashed = await store.tryAcquirePermit({
    ...base, slot: 0, permitId: 'crashed', leaseMs: 1000,
  });
  advance(1000);
  const successor = await makeStore().tryAcquirePermit({
    ...base, slot: 0, permitId: 'successor', leaseMs: 1000,
  });
  assert.equal(successor.epoch, crashed.epoch + 1);
  await assert.rejects(store.renewPermit({ ...base, ...crashed, leaseMs: 1000 }),
    /stale/);
  assert.equal(await store.releasePermit({ rootExecutionId, ...crashed }), false);
  assert.equal(await makeStore().releasePermit({ rootExecutionId, ...successor }), true);
});

test('terminal, mismatched and non-parallel roots cannot gain or renew slots', async () => {
  const { store } = await fixture();
  await assert.rejects(store.tryAcquirePermit({ ...base, userId: 'intruder',
    permitId: 'intruder', slot: 0 }), /no longer active or authorized/);
  const held = await store.tryAcquirePermit({ ...base, slot: 0, permitId: 'legitimate' });
  await store.cancel({ executionId: rootExecutionId,
    userId: base.userId, projectId: base.projectId });
  await assert.rejects(store.tryAcquirePermit({ ...base, slot: 1,
    permitId: 'afterCancel' }), /no longer active/);
  await assert.rejects(store.renewPermit({ ...base, ...held }), /terminal/);
  assert.equal(await store.releasePermit({ rootExecutionId, ...held }), true);
});

test('distributed budget queues without over-admission or holding a permit after work', async () => {
  const { store } = await fixture();
  const budget = createDistributedExecutionBudget({
    store, ...base, capacity: 2, leaseMs: 2000, renewEveryMs: 50,
    retryMs: 10, waitTimeoutMs: 2000,
    localBudget: async f => f(),
  });
  let active = 0, peak = 0, started = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  let twoStarted;
  const ready = new Promise(resolve => { twoStarted = resolve; });
  const run = () => budget(async () => {
    active++; started++;
    peak = Math.max(peak, active);
    if (started === 2) twoStarted();
    await barrier;
    active--;
    return 1;
  });
  const workers = [run(), run(), run()];
  try {
    await Promise.race([ready, new Promise((_, reject) =>
      setTimeout(() => reject(new Error('capacity was not filled')), 1000))]);
    assert.equal(active, 2);
    assert.equal(peak, 2);
  } finally { release(); }
  assert.deepEqual(await Promise.all(workers), [1, 1, 1]);
  assert.equal(started, 3);
  assert.equal(peak, 2);
});

test('a long-running admitted operation renews its lease before expiry', async () => {
  const { store, advance } = await fixture();
  const budget = createDistributedExecutionBudget({
    store, ...base, capacity: 1, leaseMs: 1000, renewEveryMs: 20,
    retryMs: 10, waitTimeoutMs: 1000,
    localBudget: async f => f(),
  });
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const running = budget(async signal => {
    entered();
    await barrier;
    assert.equal(signal.aborted, false);
    return 'renewed';
  });
  try {
    await started;
    advance(900);
    await new Promise(resolve => setTimeout(resolve, 70));
    advance(200); // Beyond original lease but within renewed lease.
    assert.equal(await store.tryAcquirePermit({ ...base, slot: 0,
      permitId: 'racing_holder', leaseMs: 1000 }), null);
  } finally { release(); }
  assert.equal(await running, 'renewed');
  assert.ok(await store.tryAcquirePermit({ ...base, slot: 0,
    permitId: 'after_work', leaseMs: 1000 }));
});

test('losing a distributed lease fails closed and notifies a cooperative handler', async () => {
  const { store } = await fixture();
  const budget = createDistributedExecutionBudget({
    store, ...base, capacity: 1, leaseMs: 1000, renewEveryMs: 20,
    retryMs: 10, waitTimeoutMs: 1000,
    localBudget: async f => f(),
  });
  store.renewPermit = async () => { throw new Error('lost remote lease'); };
  let signal;
  await assert.rejects(budget(async activeSignal => {
    signal = activeSignal;
    await new Promise(resolve => setTimeout(resolve, 65));
    return 'must not report success';
  }), /lost remote lease/);
  assert.equal(signal.aborted, true);
  assert.ok(await store.tryAcquirePermit({ ...base, slot: 0,
    permitId: 'recovered', leaseMs: 1000 }));
});

test('a saturated cross-process budget times out without permitting extra work', async () => {
  const { store } = await fixture();
  const existing = await store.tryAcquirePermit({ ...base, slot: 0,
    permitId: 'busy', leaseMs: 1000 });
  const budget = createDistributedExecutionBudget({
    store, ...base, capacity: 1, leaseMs: 1000, renewEveryMs: 20,
    retryMs: 10, waitTimeoutMs: 100,
    localBudget: async f => f(),
  });
  let entered = false;
  await assert.rejects(budget(async () => { entered = true; }), /capacity exhausted/);
  assert.equal(entered, false);
  assert.equal(await store.releasePermit({ rootExecutionId, ...existing }), true);
});
