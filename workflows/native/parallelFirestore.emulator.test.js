// Run with an isolated REAL Firestore emulator; never a production project:
// FIRESTORE_EMULATOR_HOST=127.0.0.1:8099 AWFL_NATIVE_PARALLEL_BRANCHES_BINARY=... \
//   node --test workflows/native/parallelFirestore.emulator.test.js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { NativeExecutionStore } from './executionStore.js';
import { runNativeWorkflow } from './worker.js';

const binary = process.env.AWFL_NATIVE_PARALLEL_BRANCHES_BINARY;
const enabled = Boolean(binary && process.env.FIRESTORE_EMULATOR_HOST);
if (process.env.AWFL_NATIVE_FIRESTORE_PARALLEL_REQUIRED === '1' && !enabled) {
  throw new Error('real parallel Firestore tests require emulator host and compiled Rust binary');
}
const app = enabled ? initializeApp({ projectId: 'demo-awfl-native' },
  'parallel-emulator-' + randomUUID()) : null;
const db = app && getFirestore(app);
after(async () => {
  if (db) await db.terminate();
  if (app) await deleteApp(app);
});

async function fixture({ handlers, clock }) {
  const artifactSha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  const collection = 'nativeParallelEmulator_' + randomUUID().replaceAll('-', '');
  const executionId = 'native_' + randomUUID().replaceAll('-', '');
  const store = new NativeExecutionStore({ db, collection, ...(clock && { clock }) });
  const userId = 'parallel-emulator-owner', projectId = 'parallel-emulator-project';
  await store.create({
    executionId, userId, projectId, workflowName: 'NativeParallelEmulator',
    artifactSha256, input: null, protocolVersion: 2, parallelVersion: 1,
    allowedOperations: ['native.parallel', 'http.post'],
  });
  const releases = { materialize: async digest => {
    assert.equal(digest, artifactSha256);
    return { executable: binary, sha256: artifactSha256, cleanup: async () => {} };
  } };
  const makeStore = () => new NativeExecutionStore({
    db, collection, ...(clock && { clock }),
  });
  const execute = (activeStore = store) => runNativeWorkflow({
    store: activeStore, releases, executionId, userId, projectId, handlers,
  });
  return { store, makeStore, execute, executionId, userId, projectId };
}

test('emulator + real Rust: siblings overlap, fork joins once, and a new store replays without effects',
  { skip: !enabled, timeout: 120_000 }, async () => {
    let calls = 0, active = 0, peak = 0, release;
    const barrier = new Promise(resolve => { release = resolve; });
    let bothStarted;
    const started = new Promise(resolve => { bothStarted = resolve; });
    const f = await fixture({ handlers: {
      'http.post': async ({ args }) => {
        calls++;
        active++;
        peak = Math.max(peak, active);
        if (calls === 2) bothStarted();
        await barrier;
        active--;
        return args + '-emulated';
      },
    } });
    const running = f.execute();
    let watchdog;
    try {
      await Promise.race([started, new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('emulator siblings serialized')), 30_000);
      })]);
    } finally {
      clearTimeout(watchdog);
      release();
    }
    assert.deepEqual(await running, { a: 'first-emulated', b: 'second-emulated' });
    assert.equal(peak, 2);
    assert.equal(calls, 2);
    const state = await f.makeStore().get(f.executionId);
    assert.equal(state.status, 'completed');
    assert.equal(state.effectCount, 1);
    assert.deepEqual(await f.execute(f.makeStore()),
      { a: 'first-emulated', b: 'second-emulated' });
    assert.equal(calls, 2);
  });

test('emulator + real Rust: crash after child commit recovers parent join without resending children',
  { skip: !enabled, timeout: 120_000 }, async () => {
    let now = Date.now(), calls = 0, injected = false;
    const f = await fixture({ clock: () => now, handlers: {
      'http.post': async ({ args }) => { calls++; return args + '-once'; },
    } });
    const original = f.store.recordEffect.bind(f.store);
    f.store.recordEffect = async input => {
      if (!injected && input.executionId === f.executionId &&
          input.effectId.startsWith('fork_')) {
        injected = true;
        throw new Error('injected crash before journaled parent join');
      }
      return original(input);
    };
    await assert.rejects(f.execute(), /injected crash/);
    assert.equal(calls, 2);
    const stranded = await f.makeStore().get(f.executionId);
    assert.equal(stranded.status, 'waiting_effect');
    assert.equal(stranded.pendingEffect.operation, 'native.parallel');
    now += 130_000; // Advance the same server clock beyond the fenced lease.
    assert.deepEqual(await f.execute(f.makeStore()),
      { a: 'first-once', b: 'second-once' });
    assert.equal(calls, 2);
    const final = await f.makeStore().get(f.executionId);
    assert.equal(final.status, 'completed');
    assert.equal(final.effectCount, 1);
  });

test('emulator + real Rust: cancelling the root fences its pending join and re-delivery',
  { skip: !enabled, timeout: 120_000 }, async () => {
    let calls = 0, release;
    const barrier = new Promise(resolve => { release = resolve; });
    let bothStarted;
    const started = new Promise(resolve => { bothStarted = resolve; });
    const f = await fixture({ handlers: {
      'http.post': async ({ args }) => {
        if (++calls === 2) bothStarted();
        await barrier;
        return args;
      },
    } });
    const running = f.execute();
    let watchdog;
    try {
      await Promise.race([started, new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('children not dispatched')), 30_000);
      })]);
      await f.store.cancel({
        executionId: f.executionId, userId: f.userId, projectId: f.projectId,
      });
    } finally {
      clearTimeout(watchdog);
      release();
    }
    await assert.rejects(running, /stale|lease|cancel|conflict/i);
    const cancelled = await f.makeStore().get(f.executionId);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.owner, null);
    await assert.rejects(f.execute(f.makeStore()), /cancelled/);
    assert.equal(calls, 2, 're-delivery cannot send more child effects');
  });
