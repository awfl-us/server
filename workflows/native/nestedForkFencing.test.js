import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { NativeExecutionStore } from './executionStore.js';
import { forkLaneId } from './forkCoordinator.js';

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

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rootId = 'native_' + '9'.repeat(32);
const hash = 'a'.repeat(64);

async function nestedFixture() {
  const store = new NativeExecutionStore({ db: fakeFirestore(), clock: () => 1000 });
  const input = { original: 42 };
  const base = { userId: 'owner', projectId: 'tenant', workflowName: 'NestedFork',
    artifactSha256: hash, input, protocolVersion: 2, parallelVersion: 1,
    allowedOperations: ['native.parallel'] };
  await store.create({ ...base, executionId: rootId });

  async function pending(executionId, workerId, epoch, nodeId, generation) {
    await store.prepareEffect({ executionId, workerId, epoch, nodeId,
      effectId: generation, operation: 'native.parallel',
      args: { generation, lanes: [] }, slots: {}, protocolVersion: 2 });
  }
  async function childOf(parentId, depth, nodeId, generation) {
    const index = 0, entry = 'pc_5', slots = { s1: { type: 'integer', value: depth } };
    const executionId = forkLaneId({ parentExecutionId: parentId, nodeId, generation, index });
    await store.create({ ...base, executionId, forkLane: {
      parentExecutionId: parentId, rootExecutionId: rootId, depth, nodeId,
      generation, index, entry, slots,
      snapshotSha256: digest({ input, slots, entry }),
    } });
    return { executionId, ...(await store.claim({ executionId, workerId: `worker_${depth}` })) };
  }

  const rootLease = await store.claim({ executionId: rootId, workerId: 'root' });
  await pending(rootId, 'root', rootLease.epoch, 'root_fork', 'fork_root');
  const child = await childOf(rootId, 1, 'root_fork', 'fork_root');
  await pending(child.executionId, 'worker_1', child.epoch, 'nested_fork', 'fork_child');
  const grandchild = await childOf(child.executionId, 2, 'nested_fork', 'fork_child');
  await pending(grandchild.executionId, 'worker_2', grandchild.epoch, 'deep_fork', 'fork_deep');
  const greatGrandchild = await childOf(grandchild.executionId, 3, 'deep_fork', 'fork_deep');
  return { store, rootLease, pending, child, grandchild, greatGrandchild };
}

test('all three nested fork levels are writable while every ancestor has the original intent', async () => {
  const { store, greatGrandchild } = await nestedFixture();
  await store.checkpoint({ executionId: greatGrandchild.executionId,
    workerId: 'worker_3', epoch: greatGrandchild.epoch, nodeId: 'deep_work', slots: {} });
  assert.equal((await store.get(greatGrandchild.executionId)).checkpoint.nodeId, 'deep_work');
});

test('root joining a fork fences great-grandchild even while root keeps running', async () => {
  const { store, rootLease, pending, child, grandchild, greatGrandchild } = await nestedFixture();
  await store.recordEffect({ executionId: rootId, workerId: 'root', epoch: rootLease.epoch,
    effectId: 'fork_root', outcome: ['joined'] });
  assert.equal((await store.get(rootId)).status, 'ready');
  assert.equal((await store.get(child.executionId)).status, 'waiting_effect');
  await assert.rejects(store.checkpoint({ executionId: greatGrandchild.executionId,
    workerId: 'worker_3', epoch: greatGrandchild.epoch, nodeId: 'late_effect', slots: {} }),
  /parent is no longer active/);
  await assert.rejects(store.claim({ executionId: greatGrandchild.executionId,
    workerId: 'replacement' }), /parent is no longer active/);
  await assert.rejects(store.claim({ executionId: grandchild.executionId,
    workerId: 'replacement' }), /parent is no longer active/);

  // A DIFFERENT fork on the same still-active root cannot re-authorize
  // descendants whose original generation was already joined.
  await pending(rootId, 'root', rootLease.epoch, 'new_fork', 'fork_new');
  assert.equal((await store.get(rootId)).status, 'waiting_effect');
  await assert.rejects(store.renew({ executionId: greatGrandchild.executionId,
    workerId: 'worker_3', epoch: greatGrandchild.epoch }), /parent is no longer active/);
});

test('intermediate fork join fences descendants while the root fork is still pending', async () => {
  const { store, grandchild, greatGrandchild } = await nestedFixture();
  await store.recordEffect({ executionId: grandchild.executionId,
    workerId: 'worker_2', epoch: grandchild.epoch,
    effectId: 'fork_deep', outcome: [] });
  assert.equal((await store.get(rootId)).status, 'waiting_effect');
  await assert.rejects(store.checkpoint({ executionId: greatGrandchild.executionId,
    workerId: 'worker_3', epoch: greatGrandchild.epoch, nodeId: 'late_effect', slots: {} }),
  /parent is no longer active/);
});
