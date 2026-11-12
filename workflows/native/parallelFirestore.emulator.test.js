// Run with an isolated REAL Firestore emulator; never a production project:
// FIRESTORE_EMULATOR_HOST=127.0.0.1:8099 AWFL_NATIVE_PARALLEL_BRANCHES_BINARY=... \
//   node --test workflows/native/parallelFirestore.emulator.test.js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { NativeExecutionStore } from './executionStore.js';
import { runNativeWorkflow } from './worker.js';
import { forkLaneId } from './forkCoordinator.js';

const binary = process.env.AWFL_NATIVE_PARALLEL_BRANCHES_BINARY;
const eachBinary = process.env.AWFL_NATIVE_PARALLEL_FOR_BINARY;
const nestedBinary = process.env.AWFL_NATIVE_PARALLEL_NESTED_BINARY;
const runContender = promisify(execFile);
const contenderScript = fileURLToPath(new URL('./parallelLeaseContender.emulator.js', import.meta.url));
const crashScript = fileURLToPath(new URL('./parallelCrashWorker.emulator.js', import.meta.url));
const permitScript = fileURLToPath(new URL('./parallelPermitContender.emulator.js', import.meta.url));
const enabled = Boolean(binary && process.env.FIRESTORE_EMULATOR_HOST);
if (process.env.AWFL_NATIVE_FIRESTORE_PARALLEL_REQUIRED === '1' && (!enabled || !eachBinary || !nestedBinary)) {
  throw new Error('real parallel Firestore tests require emulator host and both compiled Rust binaries');
}
const app = enabled ? initializeApp({ projectId: 'demo-awfl-native' },
  'parallel-emulator-' + randomUUID()) : null;
const db = app && getFirestore(app);
after(async () => {
  if (db) await db.terminate();
  if (app) await deleteApp(app);
});

async function fixture({ handlers, clock, executable = binary, input = null }) {
  const artifactSha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
  const collection = 'nativeParallelEmulator_' + randomUUID().replaceAll('-', '');
  const executionId = 'native_' + randomUUID().replaceAll('-', '');
  const store = new NativeExecutionStore({ db, collection, ...(clock && { clock }) });
  const userId = 'parallel-emulator-owner', projectId = 'parallel-emulator-project';
  await store.create({
    executionId, userId, projectId, workflowName: 'NativeParallelEmulator',
    artifactSha256, input, protocolVersion: 2, parallelVersion: 1,
    allowedOperations: ['native.parallel', 'http.post'],
  });
  const releases = { materialize: async digest => {
    assert.equal(digest, artifactSha256);
    return { executable, sha256: artifactSha256, cleanup: async () => {} };
  } };
  const makeStore = () => new NativeExecutionStore({
    db, collection, ...(clock && { clock }),
  });
  const execute = (activeStore = store) => runNativeWorkflow({
    store: activeStore, releases, executionId, userId, projectId, handlers,
  });
  return { store, makeStore, execute, executionId, collection, userId, projectId };
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
      await assert.rejects(f.execute(f.makeStore()), /lease held/,
        'independent duplicate Jobs delivery cannot steal the parent lease');
      const contender = await runContender(process.execPath,
        [contenderScript, f.collection, f.executionId], {
          env: process.env, timeout: 30000,
        });
      assert.match(contender.stdout, /ACTIVE_PARENT_LEASE_HELD/,
        'a separate Node process must not claim the still-active parent');
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
    const contenderAfterJoin = await runContender(process.execPath,
      [contenderScript, f.collection, f.executionId], {
        env: process.env, timeout: 30000,
      });
    assert.match(contenderAfterJoin.stdout, /ALREADY_COMPLETED/,
      'external redelivery after join observes the completed result');
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

test('emulator + real Rust ParallelFor: empty, singleton and indexed multi-item joins',
  { skip: !enabled || !eachBinary, timeout: 120_000 }, async () => {
    for (const input of [[], ['one'], ['third', 'first', 'second']]) {
      const f = await fixture({ executable: eachBinary, input, handlers: {} });
      assert.deepEqual(await f.execute(), input);
      const state = await f.makeStore().get(f.executionId);
      assert.equal(state.status, 'completed');
      assert.equal(state.effectCount, 1);
      assert.deepEqual(await f.execute(f.makeStore()), input);
    }
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
    await assert.rejects(running, /stale|lease|cancel|conflict|parent is no longer active/i);
    const cancelled = await f.makeStore().get(f.executionId);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.owner, null);
    await assert.rejects(f.execute(f.makeStore()), /cancelled/);
    assert.equal(calls, 2, 're-delivery cannot send more child effects');
    for (const index of [0, 1]) {
      const childId = forkLaneId({
        parentExecutionId: f.executionId,
        nodeId: cancelled.pendingEffect.nodeId,
        generation: cancelled.pendingEffect.effectId, index,
      });
      const child = await f.makeStore().get(childId);
      assert.equal(child.forkLane.rootExecutionId, f.executionId);
      assert.notEqual(child.status, 'completed',
        'child cannot journal a result after parent cancellation');
      await assert.rejects(f.makeStore().claim({
        executionId: childId, workerId: 'orphan_recovery',
      }), /parent is no longer active/);
    }
  });

test('emulator + real Rust: killed worker leaves fork journal empty; successor takes fenced lease',
  { skip: !enabled, timeout: 120_000 }, async () => {
    let now = Date.now(), replaySends = 0;
    const f = await fixture({ clock: () => now, handlers: {
      'http.post': async () => { replaySends++; throw new Error('duplicate remote effect'); },
    } });
    const directory = await mkdtemp(join(tmpdir(), 'awfl-native-killed-worker-'));
    const marker = join(directory, 'external-effects.jsonl');
    try {
      const crashed = await runContender(process.execPath,
        [crashScript, f.collection, f.executionId, binary, marker], {
          env: process.env, timeout: 60000,
        }).then(() => null, error => error);
      assert.equal(crashed?.code, 73,
        `child process must exit after child commit: ${crashed?.message}`);
      assert.deepEqual((await readFile(marker, 'utf8')).trim().split('\n').sort(),
        ['"first"', '"second"']);
      const stranded = await f.makeStore().get(f.executionId);
      assert.equal(stranded.status, 'waiting_effect');
      assert.equal(stranded.pendingEffect.operation, 'native.parallel');
      assert.equal(stranded.epoch, 1);
      await assert.rejects(f.execute(f.makeStore()), /lease held/,
        'successor cannot steal nonexpired parent lease');
      now += 130_000;
      assert.deepEqual(await f.execute(f.makeStore()), {
        a: 'first-killed', b: 'second-killed',
      });
      const recovered = await f.makeStore().get(f.executionId);
      assert.equal(recovered.epoch, 2);
      assert.equal(recovered.status, 'completed');
      assert.equal(replaySends, 0, 'committed children must not resend effects');
      assert.equal((await readFile(marker, 'utf8')).trim().split('\n').length, 2);
      await assert.rejects(f.makeStore().recordEffect({
        executionId: f.executionId, workerId: stranded.owner,
        epoch: stranded.epoch, effectId: stranded.pendingEffect.effectId,
        outcome: ['stale'],
      }), /stale worker/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

test('emulator: a nonterminal root finishing its fork fences all nested descendants',
  { skip: !enabled, timeout: 120_000 }, async () => {
    const f = await fixture({ handlers: {} });
    const root = await f.store.get(f.executionId);
    const rootLease = await f.store.claim({ executionId: root.executionId, workerId: 'root-worker' });
    const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    async function pending(executionId, workerId, epoch, nodeId, effectId) {
      await f.store.prepareEffect({ executionId, workerId, epoch,
        nodeId, effectId, operation: 'native.parallel',
        args: { generation: effectId, lanes: [] }, slots: {}, protocolVersion: 2 });
    }
    async function child(parentId, depth, nodeId, generation) {
      const index = 0, entry = 'pc_3';
      const slots = { s0: { type: 'integer', value: depth } };
      const executionId = forkLaneId({ parentExecutionId: parentId, nodeId, generation, index });
      await f.store.create({
        executionId, input: null, userId: root.userId, projectId: root.projectId,
        artifactSha256: root.artifactSha256, workflowName: root.workflowName,
        protocolVersion: 2, parallelVersion: 1, allowedOperations: root.allowedOperations,
        forkLane: { parentExecutionId: parentId, rootExecutionId: root.executionId,
          depth, nodeId, generation, index, entry, slots,
          snapshotSha256: digest({ input: null, slots, entry }) },
      });
      return { executionId, ...(await f.makeStore().claim({
        executionId, workerId: `worker_${depth}`, })) };
    }
    await pending(root.executionId, 'root-worker', rootLease.epoch, 'root_fork', 'fork_root');
    const first = await child(root.executionId, 1, 'root_fork', 'fork_root');
    await pending(first.executionId, 'worker_1', first.epoch, 'child_fork', 'fork_child');
    const second = await child(first.executionId, 2, 'child_fork', 'fork_child');
    await pending(second.executionId, 'worker_2', second.epoch, 'grandchild_fork', 'fork_deep');
    const third = await child(second.executionId, 3, 'grandchild_fork', 'fork_deep');
    await f.makeStore().checkpoint({ executionId: third.executionId,
      workerId: 'worker_3', epoch: third.epoch, nodeId: 'deep_start', slots: {} });
    await f.store.recordEffect({ executionId: root.executionId,
      workerId: 'root-worker', epoch: rootLease.epoch,
      effectId: 'fork_root', outcome: ['done'] });
    assert.equal((await f.makeStore().get(root.executionId)).status, 'ready');
    assert.equal((await f.makeStore().get(first.executionId)).status, 'waiting_effect');
    await assert.rejects(f.makeStore().checkpoint({ executionId: third.executionId,
      workerId: 'worker_3', epoch: third.epoch, nodeId: 'obsolete_child', slots: {} }),
    /parent is no longer active/);
    await assert.rejects(f.makeStore().claim({ executionId: third.executionId,
      workerId: 'new_process' }), /parent is no longer active/);
  });

test('emulator + generated Rust: actual three-level nested forks journal and replay all child effects',
  { skip: !enabled || !nestedBinary, timeout: 120_000 }, async () => {
    let calls = 0, active = 0, peak = 0, release, arrived;
    const seen = [];
    const barrier = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { arrived = resolve; });
    const f = await fixture({ executable: nestedBinary, handlers: {
      'http.post': async ({ args }) => {
        calls++;
        seen.push(args);
        active++;
        peak = Math.max(peak, active);
        if (calls === 2) arrived();
        await barrier;
        active--;
        return args + '-emulated';
      },
    } });
    const running = f.execute();
    let watchdog;
    try {
      await Promise.race([started, new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('nested native fork lanes were serialized')), 30_000);
      })]);
    } finally {
      clearTimeout(watchdog);
      release();
    }
    assert.equal(await running, 'nested-complete');
    assert.ok(peak >= 2, 'deep and sibling native effects must overlap');
    assert.deepEqual(seen.sort(), ['deep-a', 'deep-b', 'middle', 'outer']);
    assert.equal(calls, 4);
    const state = await f.makeStore().get(f.executionId);
    assert.equal(state.status, 'completed');
    assert.equal(state.effectCount, 1);
    // The 2+2+2 child records are pinned to depth 1, 2 and 3, and every
    // intermediate nested join is already committed in real Firestore.
    const docs = await db.collection(f.collection).get();
    const children = docs.docs.filter(doc => doc.data().forkLaneJson);
    assert.deepEqual(children.map(doc => JSON.parse(doc.data().forkLaneJson).depth).sort(),
      [1, 1, 2, 2, 3, 3]);
    assert.ok(children.every(doc => doc.data().status === 'completed'));
    assert.equal(await f.execute(f.makeStore()), 'nested-complete');
    assert.equal(calls, 4, 'a fresh worker cannot re-dispatch nested effects');
  });

test('emulator: different Node processes contend for durable admission, and crashed holders are fenced',
  { skip: !enabled, timeout: 120_000 }, async () => {
    const f = await fixture({ handlers: {} });
    const permitBase = { rootExecutionId: f.executionId, userId: f.userId,
      projectId: f.projectId };
    const contenderArgs = (slot, holder, mode = 'try') => [permitScript,
      f.collection, f.executionId, f.userId, f.projectId,
      String(slot), holder, mode];

    // Two distinct processes race for the exact same empty Firestore doc.
    // One CAS must win; neither client shares a process-local semaphore.
    const attempts = await Promise.all([
      runContender(process.execPath, contenderArgs(0, 'first_process'), {
        env: process.env, timeout: 30_000 }),
      runContender(process.execPath, contenderArgs(0, 'second_process'), {
        env: process.env, timeout: 30_000 }),
    ]);
    const verdicts = attempts.map(result => result.stdout.trim()).sort();
    assert.deepEqual(verdicts, ['ADMITTED 1', 'BUSY']);
    const winner = attempts[0].stdout.includes('ADMITTED')
      ? 'first_process' : 'second_process';
    assert.equal(await f.makeStore().releasePermit({ rootExecutionId: f.executionId,
      slot: 0, permitId: winner, epoch: 1 }), true);

    // All eight slots are root-wide. A ninth separate process is denied,
    // even though it has a fresh Store and independent Node runtime.
    const claimed = [];
    for (let slot = 0; slot < 8; slot++) {
      const lease = await f.makeStore().tryAcquirePermit({ ...permitBase,
        slot, permitId: `holder_${slot}`, leaseMs: 120_000 });
      assert.ok(lease);
      claimed.push(lease);
    }
    const denied = await runContender(process.execPath,
      contenderArgs(3, 'over_capacity'), { env: process.env, timeout: 30_000 });
    assert.equal(denied.stdout.trim(), 'BUSY');
    for (const lease of claimed) {
      assert.equal(await f.makeStore().releasePermit({
        rootExecutionId: f.executionId, ...lease }), true);
    }

    // A third independent process dies after successful claim without a
    // release. Another process can only reclaim *after* the lease expires.
    const crashed = await runContender(process.execPath,
      contenderArgs(0, 'dead_process', 'crash'), {
        env: process.env, timeout: 30_000,
      }).then(() => null, error => error);
    assert.equal(crashed?.code, 73, 'worker must actually terminate without release');
    const stranded = await f.makeStore().tryAcquirePermit({ ...permitBase,
      slot: 0, permitId: 'too_early' });
    assert.equal(stranded, null);
    const future = Date.now() + 130_000;
    const survivorStore = new NativeExecutionStore({ db, collection: f.collection,
      clock: () => future });
    const successor = await survivorStore.tryAcquirePermit({ ...permitBase,
      slot: 0, permitId: 'successor' });
    assert.ok(successor.epoch >= 3);
    assert.equal(await survivorStore.releasePermit({
      rootExecutionId: f.executionId, slot: 0, epoch: successor.epoch - 1,
      permitId: 'dead_process' }), false);
    await assert.rejects(survivorStore.renewPermit({ ...permitBase,
      slot: 0, epoch: successor.epoch - 1, permitId: 'dead_process' }), /stale/);
    assert.equal(await survivorStore.releasePermit({
      rootExecutionId: f.executionId, ...successor }), true);
  });
