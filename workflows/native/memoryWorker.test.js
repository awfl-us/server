import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { NativeExecutionStore } from './executionStore.js';
import { runNativeMemoryWorkflow } from './memoryWorker.js';

function memoryDb() {
  const docs = new Map();
  const refs = name => ({
    doc: key => ({
      key: name + '/' + key,
      async get() {
        const data = docs.get(this.key);
        return { exists: data !== undefined, data: () => structuredClone(data) };
      },
    }),
  });
  return { docs, collection: refs,
    async runTransaction(fn) {
      const writes = [];
      const tx = {
        get: ref => ref.get(),
        create: (ref, value) => writes.push([ref.key, structuredClone(value)]),
        update: (ref, value) => writes.push([ref.key, structuredClone(value)]),
      };
      const result = await fn(tx);
      for (const [key, value] of writes) docs.set(key, value);
      return result;
    },
  };
}

const binaryPath = process.env.AWFL_NATIVE_TOOLDEFS_BINARY;
const nestedBinary = process.env.AWFL_NATIVE_NESTED_EFFECTS_BINARY;
const localParent = process.env.AWFL_NATIVE_LOCAL_PARENT_BINARY;
const localChild = process.env.AWFL_NATIVE_LOCAL_CHILD_BINARY;
const localLeaf = process.env.AWFL_NATIVE_LOCAL_LEAF_BINARY;
test('real Rust ToolDefs runs with no effect journal and one initial claim/final commit', {
  skip: !binaryPath, timeout: 35_000,
}, async () => {
  const db = memoryDb();
  const store = new NativeExecutionStore({ db });
  const sha256 = createHash('sha256').update(await readFile(binaryPath)).digest('hex');
  const identity = { userId: 'owner', projectId: 'project' };
  const executionId = 'native_' + 'a'.repeat(32);
  await store.create({ executionId, ...identity, artifactSha256: sha256,
    protocolVersion: 2, workflowName: 'helpers-ToolDefs',
    trustedGlobalsVersion: 1, executionMode: 'memory',
    allowedOperations: ['http.get'],
    input: { toolNames: ['__not_a_tool__'],
      env: { BASE_URL: 'https://jobs.example.org/jobs', ...identity } },
  });
  const counts = Object.fromEntries([
    'get', 'claim', 'updateMemoryProgress', 'prepareEffect',
    'recordEffect', 'complete', 'fail',
  ].map(method => [method, 0]));
  const monitored = Object.create(store);
  for (const name of Object.keys(counts)) {
    monitored[name] = async (...args) => {
      counts[name]++;
      return store[name](...args);
    };
  }
  const oldProject = process.env.GCP_PROJECT;
  process.env.GCP_PROJECT = 'awfl-us';
  let effects = 0;
  const props = { store: monitored, executionId, ...identity,
    releases: { materialize: async () => ({ executable: binaryPath, sha256,
      cleanup: async () => {} }) },
    handlers: { 'http.get': async ({ identity: scoped }) => {
      assert.deepEqual(scoped, identity);
      effects++;
      return { code: 200, body: { items: [] } };
    } },
  };
  try {
    assert.deepEqual(await runNativeMemoryWorkflow(props), { defs: [] });
    assert.deepEqual(await runNativeMemoryWorkflow(props), { defs: [] });
    assert.equal(effects, 1, 'completed request must not rerun effects');
    assert.equal(counts.claim, 2, 'second claim reads terminal result');
    assert.equal(counts.complete, 1);
    assert.equal(counts.get, 0);
    assert.equal(counts.prepareEffect, 0);
    assert.equal(counts.recordEffect, 0);
    assert.equal(counts.updateMemoryProgress, 0, 'short workflow skips snapshots');
    assert.equal([...db.docs.keys()].filter(k => k.includes('/effects/')).length, 0);
    assert.equal((await store.get(executionId)).status, 'completed');
    assert.equal((await store.get(executionId)).effectCount, 1,
      'final effect count is included in the terminal commit');
    await assert.rejects(runNativeMemoryWorkflow({ ...props, projectId: 'wrong' }),
      /owner mismatch/);
  } finally {
    if (oldProject === undefined) delete process.env.GCP_PROJECT;
    else process.env.GCP_PROJECT = oldProject;
  }
});

test('expired memory lease restarts from input and does not replay progress snapshot', async () => {
  let now = 1000;
  const db = memoryDb();
  const store = new NativeExecutionStore({ db, clock: () => now });
  const id = 'native_' + 'b'.repeat(32);
  await store.create({ executionId: id, userId: 'owner', projectId: 'project',
    artifactSha256: 'c'.repeat(64), protocolVersion: 2,
    workflowName: 'SomeWorkflow', allowedOperations: ['http.post'],
    executionMode: 'memory', input: { example: 42 } });
  const first = await store.claim({ executionId: id, workerId: 'worker_a',
    leaseMs: 5000 });
  await store.updateMemoryProgress({ executionId: id, workerId: 'worker_a',
    epoch: first.epoch, progress: { effectCount: 4, continuation: { next_step: 3 } } });
  assert.equal((await store.get(id)).effectCount, 4);
  await assert.rejects(store.claim({ executionId: id, workerId: 'worker_b' }),
    /lease held/);
  now += 6000;
  const restarted = await store.claim({ executionId: id, workerId: 'worker_b',
    leaseMs: 5000, expectedUserId: 'owner', expectedProjectId: 'project' });
  assert.equal(restarted.epoch, first.epoch + 1);
  assert.equal(restarted.status, 'running');
  assert.equal(restarted.progressJson, null);
  assert.equal(restarted.effectCount, 0);
  assert.equal(restarted.checkpoint, null);
  assert.deepEqual(restarted.input, { example: 42 });
  await assert.rejects(store.complete({ executionId: id,
    workerId: 'worker_a', epoch: first.epoch, result: {} }), /fencing/);
});

test('eight real Rust HTTP effects run in memory in order, with no journal documents', {
  skip: !nestedBinary, timeout: 60_000,
}, async () => {
  const db = memoryDb();
  const store = new NativeExecutionStore({ db });
  const executionId = 'native_' + 'd'.repeat(32);
  const sha256 = createHash('sha256').update(await readFile(nestedBinary)).digest('hex');
  const identity = { userId: 'owner', projectId: 'project' };
  await store.create({ executionId, ...identity,
    artifactSha256: sha256, protocolVersion: 2,
    workflowName: 'NestedEffects', allowedOperations: ['http.post'],
    executionMode: 'memory', input: { env: identity } });
  let sent = 0;
  const result = await runNativeMemoryWorkflow({
    store, executionId, ...identity, progressIntervalMs: 20,
    releases: { materialize: async () => ({ executable: nestedBinary,
      sha256, cleanup: async () => {} }) },
    handlers: { 'http.post': async ({ args, identity: scoped }) => {
      assert.deepEqual(scoped, identity);
      if (sent % 2 === 0) assert.deepEqual(args, {
        url: 'https://example.org/nested-range',
      });
      else assert.equal(args, 'first-' + Math.floor(sent / 4) + '-' +
        Math.floor((sent % 4) / 2));
      const value = (sent % 2 ? 'second-' : 'first-') +
        Math.floor(sent / 4) + '-' + Math.floor((sent % 4) / 2);
      sent++;
      return value;
    } },
  });
  assert.deepEqual(result, [['second-0-0', 'second-0-1'],
    ['second-1-0', 'second-1-1']]);
  assert.equal(sent, 8);
  assert.equal((await store.get(executionId)).effectCount, 8);
  assert.equal((await store.get(executionId)).status, 'completed');
  assert.equal([...db.docs.keys()].filter(k => k.includes('/effects/')).length, 0);
});

test('compiled Try edge catches HTTP failure in local continuation, no journal', async () => {
  const db = memoryDb();
  const store = new NativeExecutionStore({ db });
  const executionId = 'native_' + 'f'.repeat(32);
  const sha256 = 'b'.repeat(64);
  const identity = { userId: 'owner', projectId: 'project' };
  await store.create({ executionId, ...identity, artifactSha256: sha256,
    protocolVersion: 2, workflowName: 'TryExample',
    allowedOperations: ['http.get'], executionMode: 'memory', input: {} });
  let steps = 0;
  const result = await runNativeMemoryWorkflow({ store, executionId, ...identity,
    releases: { materialize: async () => ({ sha256, executable: '/unused',
      cleanup: async () => {} }) },
    runArtifact: async ({ input }) => {
      steps++;
      if (steps === 1) return { protocol_version: 2, status: 'suspended',
        effect: { operation: 'http.get', effect_id: 'read_0', node_id: '0.0',
          result_slot: 's0', args: { url: 'https://jobs.example.org/resource' },
          on_error: { next_step: 2, error_slot: 's1' } },
        continuation: { next_step: 1, slots: {}, frames: [] } };
      assert.equal(input.continuation.next_step, 2);
      assert.deepEqual(input.continuation.slots.s1, { type: 'map', value: {
        message: { type: 'string', value: 'HTTP 404' },
        code: { type: 'integer', value: 404 },
      } });
      return { protocol_version: 2, status: 'completed', result: { caught: true } };
    },
    handlers: { 'http.get': async () => {
      throw Object.assign(new Error('Not Found'), { status: 404 });
    } },
  });
  assert.deepEqual(result, { caught: true });
  assert.equal(steps, 2);
  assert.equal((await store.get(executionId)).effectCount, 1);
  assert.equal([...db.docs.keys()].filter(key => key.includes('/effects/')).length, 0);
});

test('uncaught effect failure is terminal and is not retried by native memory worker', async () => {
  const db = memoryDb();
  const store = new NativeExecutionStore({ db });
  const executionId = 'native_' + 'c'.repeat(32);
  const sha256 = 'd'.repeat(64);
  const identity = { userId: 'owner', projectId: 'project' };
  await store.create({ executionId, ...identity, artifactSha256: sha256,
    protocolVersion: 2, workflowName: 'ErrorExample',
    allowedOperations: ['http.get'], executionMode: 'memory', input: {} });
  let calls = 0;
  const params = { store, executionId, ...identity,
    releases: { materialize: async () => ({ sha256, executable: '/unused',
      cleanup: async () => {} }) },
    runArtifact: async () => ({ protocol_version: 2, status: 'suspended',
      effect: { operation: 'http.get', effect_id: 'read_0', node_id: '0.0',
        result_slot: 's0', args: { url: 'https://jobs.example.org' } },
      continuation: { next_step: 1, slots: {}, frames: [] } }),
    handlers: { 'http.get': async () => { calls++; throw new Error('remote unavailable'); } },
  };
  const failure = await runNativeMemoryWorkflow(params);
  assert.equal(failure.status, 'failed');
  assert.equal((await runNativeMemoryWorkflow(params)).status, 'failed');
  assert.equal(calls, 1);
  assert.equal((await store.get(executionId)).status, 'failed');
});

test('real nested workflow.run tree commits one top-level execution and no child records', {
  skip: !(localParent && localChild && localLeaf), timeout: 90_000,
}, async () => {
  const db = memoryDb();
  const store = new NativeExecutionStore({ db });
  const id = 'native_' + '4'.repeat(32);
  const identity = { userId: 'owner', projectId: 'project' };
  const shaByName = new Map();
  for (const [name, binary, ops] of [
    ['LocalParent', localParent, ['workflow.run']],
    ['LocalChild', localChild, ['workflow.run']],
    ['LocalLeaf', localLeaf, []],
  ]) {
    shaByName.set(name, { sha256: createHash('sha256').update(await readFile(binary))
      .digest('hex'), executable: binary, allowedOperations: ops });
  }
  await store.create({ executionId: id, ...identity,
    workflowName: 'LocalParent', artifactSha256: shaByName.get('LocalParent').sha256,
    allowedOperations: ['workflow.run'], protocolVersion: 2,
    trustedGlobalsVersion: 1, executionMode: 'memory', input: {} });
  const counts = { claim: 0, complete: 0, progress: 0 };
  const watched = Object.create(store);
  for (const [method, key] of [
    ['claim', 'claim'], ['complete', 'complete'],
    ['updateMemoryProgress', 'progress'],
  ]) {
    watched[method] = async (...args) => {
      counts[key]++;
      return store[method](...args);
    };
  }
  let manifests = 0, artifacts = 0;
  const previous = process.env.GCP_PROJECT;
  process.env.GCP_PROJECT = 'awfl-us';
  try {
    const result = await runNativeMemoryWorkflow({
      store: watched, executionId: id, ...identity, progressIntervalMs: 20_000,
      handlers: {},
      releases: {
        active: async name => {
          manifests++;
          const match = shaByName.get(name);
          return match ? { workflowName: name, sha256: match.sha256,
            protocolVersion: 2, trustedGlobalsVersion: 1,
            allowedOperations: match.allowedOperations } : null;
        },
        materialize: async sha256 => {
          artifacts++;
          const match = [...shaByName.values()].find(x => x.sha256 === sha256);
          assert.ok(match);
          return { ...match, cleanup: async () => {} };
        },
      },
    });
    assert.deepEqual(result, Array.from({ length: 20 }, (_, i) => i + 3));
    assert.deepEqual(counts, { claim: 1, complete: 1, progress: 0 });
    assert.equal(manifests, 2);
    assert.equal(artifacts, 3, 'root + one cached executable per child name');
    assert.equal((await store.get(id)).effectCount, 40);
    assert.equal((await store.get(id)).status, 'completed');
    assert.deepEqual([...db.docs.keys()], ['nativeWorkflowExecutions/' + id]);
  } finally {
    if (previous === undefined) delete process.env.GCP_PROJECT;
    else process.env.GCP_PROJECT = previous;
  }
});
