import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { NativeExecutionStore } from './executionStore.js';
import { runNativeWorkflow } from './worker.js';

function fakeFirestore() {
  const docs = new Map();
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

const compiledBranches = process.env.AWFL_NATIVE_PARALLEL_BRANCHES_BINARY;
const compiledEach = process.env.AWFL_NATIVE_PARALLEL_FOR_BINARY;

async function createTest({ executable, input, handlers, executionId }) {
  const sha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
  const store = new NativeExecutionStore({ db: fakeFirestore() });
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
    await Promise.race([
      started,
      new Promise((_, reject) => setTimeout(() => reject(new Error(
        'parallel effects failed to overlap')), 20_000)),
    ]);
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
