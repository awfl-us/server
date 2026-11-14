import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { NativeExecutionStore } from './executionStore.js';
import { runNativeMemoryWorkflow } from './memoryWorker.js';
import { createMemoryParallelScheduler, NativeMemoryParallelStopped } from './memoryParallel.js';
import { NativeConfirmedWorkflowFailure } from './effectErrors.js';
import { createMemoryDetachedLauncher } from './memoryDetached.js';

function fakeFirestore() {
  const docs = new Map();
  let transactions = 0;
  return {
    docs, get transactions() { return transactions; },
    collection: name => ({ doc: key => ({ key: name + '/' + key,
      async get() {
        const val = docs.get(this.key);
        return { exists: val !== undefined, data: () => structuredClone(val) };
      } }) }),
    async runTransaction(fn) {
      transactions++;
      const changes = [];
      const tx = { get: ref => ref.get(),
        create: (ref, val) => changes.push([ref.key, structuredClone(val)]),
        update: (ref, val) => changes.push([ref.key, structuredClone(val)]) };
      const result = await fn(tx);
      for (const [key, val] of changes) docs.set(key, val);
      return result;
    },
  };
}

let ordinal = 0;
async function fixture(executable, input = null, handler = async () => null) {
  const id = 'native_' + (++ordinal).toString(16).padStart(32, '0');
  const sha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
  const db = fakeFirestore(), store = new NativeExecutionStore({ db });
  const identity = { userId: 'owner', projectId: 'tenant' };
  await store.create({
    executionId: id, ...identity, workflowName: 'NativeParallelTest',
    artifactSha256: sha256, protocolVersion: 2, parallelVersion: 1,
    allowedOperations: ['native.parallel', 'http.post'],
    trustedGlobalsVersion: 1, executionMode: 'memory', input,
  });
  let calls = 0;
  return {
    id, db, store, get calls() { return calls; },
    execute: () => runNativeMemoryWorkflow({
      store, executionId: id, ...identity, progressIntervalMs: 60000,
      releases: { materialize: async hash => {
        assert.equal(hash, sha256);
        return { executable, sha256, cleanup: async () => {} };
      } },
      handlers: { 'http.post': async req => {
        calls++;
        assert.deepEqual(req.identity, identity);
        return handler(req);
      } },
    }),
  };
}

const branches = process.env.AWFL_NATIVE_PARALLEL_BRANCHES_BINARY;
const each = process.env.AWFL_NATIVE_PARALLEL_FOR_BINARY;
const nested = process.env.AWFL_NATIVE_PARALLEL_NESTED_BINARY;
const caught = process.env.AWFL_NATIVE_PARALLEL_CAUGHT_BINARY;
const uncaught = process.env.AWFL_NATIVE_PARALLEL_UNCAUGHT_BINARY;

test('memory parallel only allows root documents', async () => {
  const db = fakeFirestore(), store = new NativeExecutionStore({ db });
  const base = { executionId: 'native_' + 'd'.repeat(32), userId: 'u',
    projectId: 'p', workflowName: 'Parallel', artifactSha256: 'e'.repeat(64),
    protocolVersion: 2, parallelVersion: 1, allowedOperations: ['native.parallel'],
    executionMode: 'memory', input: null };
  await store.create(base);
  assert.equal((await store.get(base.executionId)).parallelVersion, 1);
  await assert.rejects(store.create({ ...base,
    executionId: 'native_' + 'f'.repeat(32), forkLane: { entry: 'pc_3' } }),
  /memory execution requires a root/);
});

test('shared semaphore bounds handlers and overlaps branches', async () => {
  const scheduler = createMemoryParallelScheduler({ maxEffects: 2 });
  let active = 0, peak = 0, release, ready;
  const barrier = new Promise(resolve => { release = resolve; });
  const bothReady = new Promise(resolve => { ready = resolve; });
  const effect = { node_id: '0.1', args: { generation: 'fork_0',
    lanes: Array.from({ length: 3 }, (_, i) => ({ entry: 'pc_' + i, slots: {} })) } };
  const pending = scheduler.runFork({
    effect, executionId: 'native_' + 'a'.repeat(32), forkDepth: 0,
    runLane: async ({ index }) => scheduler.withEffectPermit(async () => {
      active++; peak = Math.max(active, peak);
      if (peak === 2) ready();
      await barrier;
      active--;
      return index;
    }),
  });
  let timer;
  try {
    await Promise.race([bothReady, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('handlers serialized')), 4000);
    })]);
    assert.equal(peak, 2);
  } finally { clearTimeout(timer); release(); }
  assert.deepEqual(await pending, [0, 1, 2]);
  assert.equal(scheduler.activeEffects, 0);
});

test('real Rust Parallel overlaps effects, no lane docs or journals', {
  skip: !branches, timeout: 35000,
}, async () => {
  let active = 0, peak = 0, release, ready;
  const barrier = new Promise(resolve => { release = resolve; });
  const bothReady = new Promise(resolve => { ready = resolve; });
  const f = await fixture(branches, null, async ({ args }) => {
    active++; peak = Math.max(active, peak);
    if (peak === 2) ready();
    await barrier; active--;
    return args + '-completed';
  });
  const running = f.execute();
  let timer;
  try {
    await Promise.race([bothReady, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('compiled branches serialized')), 15000);
    })]);
    assert.equal(peak, 2);
  } finally { clearTimeout(timer); release(); }
  assert.deepEqual(await running, { a: 'first-completed', b: 'second-completed' });
  assert.equal(f.calls, 2);
  assert.equal((await f.store.get(f.id)).effectCount, 3);
  assert.equal(f.db.transactions, 3);
  assert.equal([...f.db.docs.keys()].filter(x => x.includes('/effects/')).length, 0);
  assert.equal([...f.db.docs.keys()].length, 1);
  assert.deepEqual(await f.execute(), { a: 'first-completed', b: 'second-completed' });
  assert.equal(f.calls, 2);
});

test('real Rust ParallelFor zero/one/many returns ordered input', {
  skip: !each, timeout: 35000,
}, async () => {
  for (const input of [[], ['one'], ['third', 'first', 'second']]) {
    const f = await fixture(each, input);
    assert.deepEqual(await f.execute(), input);
    assert.equal(f.db.transactions, 3);
    assert.equal([...f.db.docs.keys()].length, 1);
  }
});

test('real nested Rust Parallel executes and joins without deadlock', {
  skip: !nested, timeout: 35000,
}, async () => {
  const events = [];
  const f = await fixture(nested, null, async ({ args }) => {
    events.push(args);
    return args + '-completed';
  });
  assert.equal(await f.execute(), 'nested-complete');
  assert.deepEqual(events.sort(), ['deep-a', 'deep-b', 'middle', 'outer']);
  assert.equal(f.db.transactions, 3);
  assert.equal(f.db.docs.size, 1);
});

test('real Rust parallel branch error follows compiled Try', {
  skip: !caught, timeout: 30000,
}, async () => {
  const f = await fixture(caught);
  assert.equal(await f.execute(), 'definitive branch failure');
  assert.equal((await f.store.get(f.id)).status, 'completed');
  assert.equal(f.db.transactions, 3);
});

test('uncaught branch Raise fails whole root with no child journal', {
  skip: !uncaught, timeout: 30000,
}, async () => {
  const f = await fixture(uncaught);
  const result = await f.execute();
  assert.equal(result.status, 'failed');
  assert.match(result.error.message, /definitive branch failure/);
  assert.equal((await f.store.get(f.id)).status, 'failed');
  assert.equal(f.db.transactions, 3);
});


test('concurrent branch failure drains running sibling and preserves confirmed error', async () => {
  const scheduler = createMemoryParallelScheduler({ maxEffects: 2 });
  let siblingStarted, releaseSibling, started;
  started = new Promise(resolve => { siblingStarted = resolve; });
  const delay = new Promise(resolve => { releaseSibling = resolve; });
  const effect = { node_id: '0.0', args: { generation: 'fork_1',
    lanes: [{ entry: 'pc_3', slots: {} }, { entry: 'pc_4', slots: {} }] } };
  let drained = false;
  const pending = scheduler.runFork({
    effect, executionId: 'native_' + 'b'.repeat(32), forkDepth: 0,
    runLane: async ({ index, shouldStop }) => {
      if (index === 1) {
        siblingStarted();
        await delay;
        drained = true;
        if (shouldStop()) throw new NativeMemoryParallelStopped();
        return 'unexpected';
      }
      await started;
      throw new NativeConfirmedWorkflowFailure({ message: 'branch failed', code: null });
    },
  });
  // Fail the first lane while the second remains suspended.
  await started;
  releaseSibling();
  await assert.rejects(pending, /branch failed/);
  assert.equal(drained, true);
  assert.equal(scheduler.activeEffects, 0);
});

test('independent detached child from memory root is idempotent and durable', async () => {
  const db = fakeFirestore(), store = new NativeExecutionStore({ db });
  const rootId = 'native_' + 'a'.repeat(32);
  const identity = { userId: 'verified-owner', projectId: 'verified-project' };
  const releases = { active: async name => name === 'NativeChild' ? {
    sha256: 'c'.repeat(64), protocolVersion: 2, parallelVersion: 1,
    allowedOperations: ['native.parallel', 'http.post'],
  } : null };
  const enqueued = [];
  const schedule = { enqueue: value => enqueued.push(value) };
  const launcher = createMemoryDetachedLauncher({
    store, releases, handlers: {}, executionId: rootId,
    ...identity, asyncScheduler: schedule,
  });
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    const req = { name: 'NativeChild', path: 'root:fork:0.2:g1:0',
      effectId: 'call_1', args: { argument: { task: 42 } } };
    const first = await launcher(req);
    const again = await launcher(req);
    assert.deepEqual(first, again);
    assert.equal(first.state, 'ACTIVE');
    assert.equal(db.docs.size, 1, 'a separate detached root is the only new document');
    assert.equal(enqueued.length, 2, 'same stable detached ID is safe to enqueue again');
    assert.equal(enqueued[0].executionId, enqueued[1].executionId);
    const child = await store.get(enqueued[0].executionId);
    assert.equal(child.asyncLaunch, true);
    assert.equal(child.parallelVersion, 1);
    await assert.rejects(launcher({
      ...req, args: { argument: { task: 99 } },
    }), /idempotency conflict/);
    assert.equal(db.docs.size, 1);
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});
