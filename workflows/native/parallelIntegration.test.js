import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { NativeExecutionStore } from './executionStore.js';
import { runNativeWorkflow } from './worker.js';

function fakeFirestore() {
  const docs = new Map();
  let transactionTail = Promise.resolve();
  return {
    collection: name => ({
      doc: key => ({
        key: name + '/' + key,
        async get() {
          const value = docs.get(this.key);
          return { exists: value !== undefined, data: () => structuredClone(value) };
        },
      }),
    }),
    async runTransaction(fn) {
      // The real Firestore emulator guarantees that two racing transactions
      // cannot both reserve the same permit slot. Keep this in-memory store
      // serializable too; otherwise nested test workers can double-admit.
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

const compiledBranches = process.env.AWFL_NATIVE_PARALLEL_BRANCHES_BINARY;
const compiledEach = process.env.AWFL_NATIVE_PARALLEL_FOR_BINARY;
const compiledNested = process.env.AWFL_NATIVE_PARALLEL_NESTED_BINARY;

test('real compiled three-level Parallel forks, journals each nested effect, and replays once',
  { skip: !compiledNested, timeout: 120_000 }, async () => {
    let calls = 0, active = 0, peak = 0, release;
    const seen = [];
    const barrier = new Promise(resolve => { release = resolve; });
    let concurrent;
    const twoReady = new Promise(resolve => { concurrent = resolve; });
    const fixture = await createTest({
      executable: compiledNested, input: null,
      executionId: 'native_' + '8'.repeat(32),
      handlers: { 'http.post': async ({ args }) => {
        seen.push(args);
        calls++;
        active++;
        peak = Math.max(peak, active);
        if (calls === 2) concurrent();
        await barrier;
        active--;
        return args + '-completed';
      } },
    });
    const running = fixture.execute();
    let watchdog;
    try {
      await Promise.race([twoReady, new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('nested forks failed to overlap')), 20_000);
      })]);
    } finally {
      clearTimeout(watchdog);
      release();
    }
    assert.equal(await running, 'nested-complete');
    assert.equal(peak >= 2, true);
    assert.equal(calls, 4);
    assert.deepEqual(seen.sort(), ['deep-a', 'deep-b', 'middle', 'outer']);
    const root = await fixture.store.get('native_' + '8'.repeat(32));
    assert.equal(root.status, 'completed');
    assert.equal(root.effectCount, 1);
    assert.equal(await fixture.execute(), 'nested-complete');
    assert.equal(calls, 4, 're-delivery must not resend any nested child effects');
  });

async function createTest({ executable, input, handlers, executionId, clock }) {
  const sha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
  const store = new NativeExecutionStore({
    db: fakeFirestore(), ...(clock && { clock }),
  });
  const userId = 'verified-user', projectId = 'tenant-project';
  await store.create({
    executionId, userId, projectId, workflowName: 'NativeParallelTest',
    input, artifactSha256: sha256, protocolVersion: 2, parallelVersion: 1,
    allowedOperations: ['native.parallel', 'http.post'],
  });
  let materializations = 0;
  const releases = {
    materialize: async digest => {
      assert.equal(digest, sha256);
      materializations++;
      return { executable, sha256, cleanup: async () => {} };
    },
  };
  return {
    store, releases,
    execute: () => runNativeWorkflow({
      store, releases, executionId, userId, projectId, handlers,
    }),
    materializations: () => materializations,
  };
}

test('real compiled Parallel has truly concurrent effects, durable child result/journal, and idempotent join',
  { skip: !compiledBranches }, async () => {
    let active = 0, peak = 0, calls = 0;
    let openBarrier;
    const barrier = new Promise(resolve => { openBarrier = resolve; });
    let bothStarted;
    const started = new Promise(resolve => { bothStarted = resolve; });
    const fixture = await createTest({
      executable: compiledBranches, input: null,
      executionId: 'native_' + 'a'.repeat(32),
      handlers: {
        'http.post': async ({ args }) => {
          calls++;
          active++;
          peak = Math.max(peak, active);
          if (calls === 2) bothStarted();
          await barrier;
          active--;
          return args + '-completed';
        },
      },
    });
    const executing = fixture.execute();
    // Cancel the watchdog once both branches start: otherwise the dangling
    // timer holds the Node test process alive for another 20 seconds.
    let watchdog;
    try {
      await Promise.race([
        started,
        new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error(
          'parallel effects failed to overlap')), 20_000); }),
      ]);
    } finally {
      clearTimeout(watchdog);
    }
    assert.equal(peak, 2);
    openBarrier();
    assert.deepEqual(await executing, {
      a: 'first-completed', b: 'second-completed',
    });
    assert.equal(calls, 2);
    assert.equal(fixture.materializations(), 1,
      'child execution should reuse one pinned ELF copy');
    const stored = await fixture.store.get('native_' + 'a'.repeat(32));
    assert.equal(stored.status, 'completed');
    assert.equal(stored.effectCount, 1, 'fork effect must be journaled once');
    assert.deepEqual(await fixture.execute(), {
      a: 'first-completed', b: 'second-completed',
    });
    assert.equal(calls, 2, 'replayed parent cannot repeat child effects');
  });

test('real compiled ParallelFor runs indexed lanes and joins results in input order',
  { skip: !compiledEach }, async () => {
    for (const [index, input] of [[], ['one'], ['third', 'first', 'second']].entries()) {
      const fixture = await createTest({
        executable: compiledEach, input,
        executionId: 'native_' + String(index + 1).repeat(32),
        handlers: {},
      });
      assert.deepEqual(await fixture.execute(), input);
      assert.deepEqual(await fixture.execute(), input);
      assert.equal(fixture.materializations(), 1);
      const state = await fixture.store.get('native_' + String(index + 1).repeat(32));
      assert.equal(state.status, 'completed');
    }
  });

test('fork recovery after committed child effects never redispatches them',
  { skip: !compiledBranches }, async () => {
    let now = Date.now(), effects = 0, injected = false;
    const executionId = 'native_' + 'c'.repeat(32);
    const fixture = await createTest({
      executable: compiledBranches, input: null, executionId,
      clock: () => now,
      handlers: {
        'http.post': async ({ args }) => {
          effects++;
          return args + '-once';
        },
      },
    });
    const record = fixture.store.recordEffect.bind(fixture.store);
    fixture.store.recordEffect = async input => {
      if (!injected && input.executionId === executionId &&
          input.effectId.startsWith('fork_')) {
        injected = true;
        throw new Error('simulated crash after durable children, before parent journal');
      }
      return record(input);
    };
    await assert.rejects(fixture.execute(), /simulated crash/);
    assert.equal(effects, 2);
    const stranded = await fixture.store.get(executionId);
    assert.equal(stranded.status, 'waiting_effect');
    assert.equal(stranded.pendingEffect?.operation, 'native.parallel');
    // The second Tasks delivery takes over an expired parent lease and
    // reconciles from existing completed child records, never sending HTTP.
    now += 130_000;
    assert.deepEqual(await fixture.execute(), {
      a: 'first-once', b: 'second-once',
    });
    assert.equal(effects, 2, 'completed child effects were never retried');
    const completed = await fixture.store.get(executionId);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.effectCount, 1);
    assert.equal((await fixture.store.getEffect(executionId,
      stranded.pendingEffect.effectId)).isError, undefined);
  });

const compiledCaught = process.env.AWFL_NATIVE_PARALLEL_CAUGHT_BINARY;
const compiledUncaught = process.env.AWFL_NATIVE_PARALLEL_UNCAUGHT_BINARY;

test('a terminal child Raise resumes the parent compiled Try catch',
  { skip: !compiledCaught }, async () => {
    const executionId = 'native_' + '4'.repeat(32);
    const fixture = await createTest({
      executable: compiledCaught, input: null,
      executionId, handlers: {},
    });
    assert.equal(await fixture.execute(), 'definitive branch failure');
    const state = await fixture.store.get(executionId);
    assert.equal(state.status, 'completed');
    assert.equal(state.effectCount, 1);
    const fork = await fixture.store.getEffect(executionId, 'fork_0_0_try_0');
    assert.equal(fork?.isError, true);
    assert.deepEqual(await fixture.execute(), 'definitive branch failure');
  });

test('an uncaught child Raise durably fails the parent exactly once',
  { skip: !compiledUncaught }, async () => {
    const executionId = 'native_' + '5'.repeat(32);
    const fixture = await createTest({
      executable: compiledUncaught, input: null,
      executionId, handlers: {},
    });
    const result = await fixture.execute();
    assert.equal(result.status, 'failed');
    assert.match(result.error.message, /definitive branch failure/);
    const state = await fixture.store.get(executionId);
    assert.equal(state.status, 'failed');
    assert.equal(state.pendingEffect, null);
    assert.equal(state.effectCount, 1);
    assert.deepEqual(await fixture.execute(), result);
  });
