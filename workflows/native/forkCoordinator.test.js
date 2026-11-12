import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeForkCoordinator, forkLaneId } from './forkCoordinator.js';

const parentId = 'native_' + 'e'.repeat(32);
const sha = '1'.repeat(64);
const parent = () => ({
  executionId: parentId, userId: 'real-owner', projectId: 'tenant-project',
  workflowName: 'ConcurrentWorkflow', artifactSha256: sha,
  protocolVersion: 2, parallelVersion: 1, trustedGlobalsVersion: 1,
  allowedOperations: ['http.post'], input: { env: { userId: 'forged' } },
  pendingEffect: { effectId: 'parallel_node_0', nodeId: '0.5', operation: 'native.parallel' },
});

function fixture(worker) {
  const records = new Map();
  const creates = [];
  const store = {
    create: async params => {
      creates.push(params);
      if (records.has(params.executionId)) {
        throw Object.assign(new Error('already exists'), { code: 'CONFLICT' });
      }
      const state = { ...params, status: 'ready' };
      records.set(params.executionId, state);
      return state;
    },
    get: async id => records.get(id) || null,
  };
  const coordinator = new NativeForkCoordinator({
    store, maxConcurrency: 2, runLane: params => worker(params, records),
  });
  return { store, records, creates, coordinator };
}

const args = () => ({
  parent: parent(), effectId: 'parallel_node_0', nodeId: '0.5', generation: '0.5_3',
  lanes: [
    { entry: 'pc_3', slots: { s0: { type: 'string', value: 'snapshot' } } },
    { entry: 'pc_4', slots: { s0: { type: 'string', value: 'snapshot' } } },
    { entry: 'pc_5', slots: { s0: { type: 'string', value: 'snapshot' } } },
  ],
});

test('lane identity is stable across retries, unique by parent node, generation and index', () => {
  const id = forkLaneId({ parentExecutionId: parentId, nodeId: '0.5', generation: '0.5_3', index: 1 });
  assert.match(id, /^native_[a-f0-9]{32}$/);
  assert.equal(id, forkLaneId({ parentExecutionId: parentId, nodeId: '0.5', generation: '0.5_3', index: 1 }));
  assert.notEqual(id, forkLaneId({ parentExecutionId: parentId, nodeId: '0.5', generation: '0.5_4', index: 1 }));
  assert.notEqual(id, forkLaneId({ parentExecutionId: parentId, nodeId: '0.5', generation: '0.5_3', index: 2 }));
  assert.throws(() => forkLaneId({ parentExecutionId: parentId, nodeId: '../escape', generation: '0', index: 1 }));
});

test('two lanes genuinely overlap; bounded scheduler returns input-order results and skips committed lanes', async () => {
  let active = 0, peak = 0, entered = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  let bothReady;
  const ready = new Promise(resolve => { bothReady = resolve; });
  const f = fixture(async ({ executionId, index }, records) => {
    active++;
    peak = Math.max(peak, active);
    if (++entered === 2) bothReady();
    await barrier;
    records.get(executionId).status = 'completed';
    records.get(executionId).result = `result-${index}`;
    active--;
  });
  const firstRun = f.coordinator.execute(args());
  // If this raced serially the second lane could not arrive before release.
  await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('lanes were serialized')), 2000))]);
  assert.equal(peak, 2);
  release();
  assert.deepEqual(await firstRun, ['result-0', 'result-1', 'result-2']);
  assert.equal(entered, 3);
  assert.equal(f.creates.length, 3);
  assert.deepEqual(await f.coordinator.execute(args()), ['result-0', 'result-1', 'result-2']);
  assert.equal(entered, 3, 'durably completed children never run again');
  assert.equal(f.creates[0].forkLane.parentExecutionId, parentId);
  assert.equal(f.creates[0].forkLane.rootExecutionId, parentId);
  assert.equal(f.creates[0].forkLane.depth, 1);
  assert.equal(f.creates[0].trustedGlobalsVersion, 1);
  assert.equal(f.creates[0].projectId, 'tenant-project');
});

test('worker crash after durable child completion recovers without resending effect', async () => {
  let calls = 0;
  const f = fixture(async ({ executionId, index }, records) => {
    calls++;
    records.get(executionId).status = 'completed';
    records.get(executionId).result = index;
    if (calls === 1) throw new Error('process died after child commit');
  });
  await assert.rejects(f.coordinator.execute({ ...args(), lanes: args().lanes.slice(0, 1) }), /process died/);
  assert.deepEqual(await f.coordinator.execute({ ...args(), lanes: args().lanes.slice(0, 1) }), [0]);
  assert.equal(calls, 1);
});

test('rejects untrusted forks, replay with different slot snapshot, and uncommitted child result', async () => {
  const f = fixture(async () => {});
  await assert.rejects(f.coordinator.execute({ ...args(), parent: { ...parent(), parallelVersion: undefined } }), /untrusted|unpinned/);
  await assert.rejects(f.coordinator.execute({ ...args(), parent: { ...parent(), pendingEffect: null } }), /untrusted|unpinned/);
  await assert.rejects(f.coordinator.execute({ ...args(), lanes: [{ entry: '../bad', slots: {} }] }), /invalid compiled/);
  await assert.rejects(f.coordinator.execute({ ...args(), lanes: args().lanes.slice(0, 1) }), /no durable completed result/);
  await assert.rejects(f.coordinator.execute({
    ...args(), lanes: [{ entry: 'pc_3', slots: { s0: { type: 'string', value: 'changed' } } }],
  }), /identity mismatch/);
});
