import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createExecutionBudget, runNativeWorkflow } from './worker.js';
import { NativeExecutionStore } from './executionStore.js';

test('shared native permit budget never over-admits on release and immediate new arrival', async () => {
  const budget = createExecutionBudget(2);
  let active = 0, peak = 0;
  const gates = [];
  const enter = () => budget(async () => {
    active++;
    peak = Math.max(active, peak);
    await new Promise(resolve => gates.push(resolve));
    active--;
  });
  const first = enter(), second = enter(), third = enter(), fourth = enter();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gates.length, 2);
  gates.shift()();
  const fifth = enter(); // Competes with the released waiter's continuation.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gates.length, 2, 'only one waiter inherits the released permit');
  assert.equal(peak, 2, 'new arrivals cannot exceed bounded concurrency');
  for (let i = 0; i < 3; i++) {
    gates.shift()();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(active <= 2);
  }
  gates.shift()();
  await Promise.all([first, second, third, fourth, fifth]);
  assert.equal(active, 0);
  assert.equal(peak, 2);
  assert.throws(() => createExecutionBudget(0), /positive capacity/);
});

const binaryPath = process.env.AWFL_NATIVE_V2_NESTED_RANGE_BINARY;
test('real Rust worker completes eight pinned effects with trusted user and project', {
  skip: !binaryPath, timeout: 120_000,
}, async () => {
  const sha256 = createHash('sha256').update(await readFile(binaryPath)).digest('hex');
  const identity = { userId: 'verified-user', projectId: 'project-a' };
  const state = {
    executionId: 'native_' + 'a'.repeat(32), ...identity,
    workflowName: 'NativePilot', artifactSha256: sha256,
    protocolVersion: 2, allowedOperations: ['http.post'],
    status: 'ready', input: { env: identity },
    owner: null, epoch: 0, leaseUntil: 0,
    checkpoint: null, pendingEffect: null, effectCount: 0,
  };
  const journal = new Map();
  const store = {
    get: async () => ({ ...state }),
    claim: async ({ workerId }) => {
      if (state.status === 'completed') return { completed: true, result: state.result };
      if (state.owner && state.owner !== workerId) throw new Error('lease held');
      state.owner = workerId;
      if (!state.epoch) state.epoch++;
      state.leaseUntil = Date.now() + 60_000;
      return { ...state };
    },
    prepareEffect: async ({ effectId, nodeId, operation, args, continuation, resultSlot }) => {
      assert.equal(state.pendingEffect, null);
      state.status = 'waiting_effect';
      state.pendingEffect = {
        effectId, nodeId, operation, args,
        fingerprint: effectId, preparedAt: Date.now(), resultSlot,
      };
      state.checkpoint = continuation;
    },
    recordEffect: async ({ effectId, outcome }) => {
      assert.equal(state.pendingEffect.effectId, effectId);
      journal.set(effectId, outcome);
      state.checkpoint.slots[state.pendingEffect.resultSlot] = {
        type: 'string', value: outcome,
      };
      state.pendingEffect = null;
      state.status = 'ready';
      state.effectCount++;
    },
    complete: async ({ result }) => {
      state.status = 'completed';
      state.result = result;
    },
  };
  let sent = 0;
  const handlers = { 'http.post': async ({ args, identity: granted }) => {
    assert.deepEqual(granted, identity);
    if (sent % 2 === 0) assert.deepEqual(args, {
      url: 'https://example.org/nested-range',
    });
    else assert.equal(args, 'first-' + Math.floor(sent / 4) + '-' + Math.floor((sent % 4) / 2));
    const response = (sent % 2 ? 'second-' : 'first-') +
      Math.floor(sent / 4) + '-' + Math.floor((sent % 4) / 2);
    sent++;
    return response;
  } };
  const result = await runNativeWorkflow({
    store,
    releases: { materialize: async () => ({
      executable: binaryPath, sha256, cleanup: async () => {},
    }) },
    executionId: state.executionId, ...identity, handlers,
    workerId: 'worker_a',
  });
  assert.deepEqual(result, [['second-0-0', 'second-0-1'], ['second-1-0', 'second-1-1']]);
  assert.equal(state.status, 'completed');
  assert.equal(sent, 8);
  assert.equal(journal.size, 8);
  assert.deepEqual(await runNativeWorkflow({
    store, releases: { materialize: async () => {
      throw new Error('must not redownload completed artifact');
    } },
    executionId: state.executionId, ...identity, handlers, workerId: 'worker_b',
  }), result);
  await assert.rejects(runNativeWorkflow({
    store, releases: {}, executionId: state.executionId,
    userId: 'spoofed', projectId: 'project-a', handlers,
  }), /does not match trusted Jobs task identity/);
});

test('native worker rejects project impersonation before loading an artifact', async () => {
  let fetched = 0;
  await assert.rejects(runNativeWorkflow({
    executionId: 'native_a', userId: 'owner', projectId: 'wrong',
    store: { get: async () => ({
      userId: 'owner', projectId: 'correct', protocolVersion: 2,
    }) },
    releases: { materialize: async () => { fetched++; } },
    handlers: {},
  }), /does not match trusted Jobs task identity/);
  assert.equal(fetched, 0);
});

const toolDefsBinary = process.env.AWFL_NATIVE_TOOLDEFS_BINARY;
test('real ToolDefs Rust effect retains durable journal with one claim and two reads', {
  skip: !toolDefsBinary, timeout: 40_000,
}, async () => {
  const docs = new Map();
  const db = {
    collection: name => ({ doc: key => ({ key: name + '/' + key,
      async get() {
        const data = docs.get(this.key);
        return { exists: data !== undefined, data: () => structuredClone(data) };
      },
    }) }),
    async runTransaction(fn) {
      const writes = [];
      const tx = {
        get: ref => ref.get(),
        create: (ref, value) => writes.push([ref.key, structuredClone(value)]),
        update: (ref, value) => writes.push([ref.key, structuredClone(value)]),
      };
      const outcome = await fn(tx);
      for (const [key, value] of writes) docs.set(key, value);
      return outcome;
    },
  };
  const store = new NativeExecutionStore({ db });
  const sha256 = createHash('sha256').update(await readFile(toolDefsBinary)).digest('hex');
  const executionId = 'native_' + 'a'.repeat(32);
  const identity = { userId: 'test-owner', projectId: 'test-project' };
  await store.create({ executionId, ...identity, artifactSha256: sha256,
    workflowName: 'helpers-ToolDefs', protocolVersion: 2,
    trustedGlobalsVersion: 1, allowedOperations: ['http.get'],
    input: { toolNames: ['__awfl_native_probe__'],
      env: { BASE_URL: 'https://jobs.example.org/jobs', ...identity } },
  });
  const counts = Object.fromEntries([
    'get', 'claim', 'renew', 'prepareEffect', 'recordEffect', 'complete',
  ].map(name => [name, 0]));
  const counted = Object.create(store);
  for (const name of Object.keys(counts)) {
    counted[name] = async (...args) => { counts[name]++; return store[name](...args); };
  }
  const previousProject = process.env.GCP_PROJECT;
  process.env.GCP_PROJECT = 'awfl-us';
  let effects = 0;
  try {
    const result = await runNativeWorkflow({
      store: counted, executionId, ...identity,
      releases: { materialize: async () => ({
        executable: toolDefsBinary, sha256, cleanup: async () => {},
      }) },
      handlers: { 'http.get': async ({ identity: authorized }) => {
        assert.deepEqual(authorized, identity);
        effects++;
        return { code: 200, body: { items: [] } };
      } },
    });
    assert.deepEqual(result, { defs: [] });
    assert.equal(effects, 1);
    assert.deepEqual(counts, {
      get: 2, claim: 1, renew: 0, prepareEffect: 1,
      recordEffect: 1, complete: 1,
    });
    assert.equal((await store.get(executionId)).status, 'completed');
    assert.equal((await store.getEffect(executionId,
      [...docs.keys()].find(key => key.includes('/effects/')).split('/').at(-1))).outcome.code, 200);
  } finally {
    if (previousProject === undefined) delete process.env.GCP_PROJECT;
    else process.env.GCP_PROJECT = previousProject;
  }
});
