// Real Firestore emulator tests; no production Firestore or real HTTP requests.
// FIRESTORE_EMULATOR_HOST=127.0.0.1:8099 node --test workflows/native/executionStore.emulator.test.js
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { NativeExecutionStore } from './executionStore.js';
import { NativeEffectDispatcher } from './effectDispatcher.js';
import { executeNativeStep } from './runner.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
let db;
if (enabled) {
  if (process.env.AWFL_FIRESTORE_CLIENT_ROOT) {
    const require = createRequire(process.env.AWFL_FIRESTORE_CLIENT_ROOT + '/package.json');
    const { Firestore } = require('@google-cloud/firestore');
    db = new Firestore({ projectId: 'demo-awfl-native' });
  } else {
    const { initializeApp } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');
    db = getFirestore(initializeApp({ projectId: 'demo-awfl-native' }, 'native-emulator-tests'));
  }
}
after(async () => { if (db) await db.terminate(); });
let sequence = 0;
const fixture = (clock = () => Date.now()) => new NativeExecutionStore({
  db, clock, collection: 'nativeEmulator_' + process.pid + '_' + Date.now() + '_' + (++sequence),
});
const setup = async (clock, input = {}) => {
  const store = fixture(clock);
  await store.create({ executionId: 'exec1', userId: 'owner', projectId: 'proj',
    artifactSha256: 'a'.repeat(64), input });
  return store;
};

test('emulator: simultaneous claims serialize; takeover fences old worker', {
  skip: !enabled, timeout: 90_000,
}, async () => {
  let now = 1000;
  const store = await setup(() => now);
  const workers = Array.from({ length: 12 }, (_, i) => 'worker_' + i);
  const claims = await Promise.allSettled(workers.map(workerId =>
    store.claim({ executionId: 'exec1', workerId, leaseMs: 2000 })));
  const winners = claims.map((r, i) => r.status === 'fulfilled' ? i : -1).filter(i => i >= 0);
  assert.equal(winners.length, 1, JSON.stringify(claims.map(r => r.status === 'rejected' ?
    r.reason.message : 'epoch=' + r.value.epoch)));
  const winner = workers[winners[0]];
  assert.equal((await store.claim({ executionId: 'exec1', workerId: winner })).epoch, 1);
  now = 3100;
  assert.equal((await store.claim({ executionId: 'exec1',
    workerId: 'successor' })).epoch, 2);
  await assert.rejects(store.checkpoint({ executionId: 'exec1', workerId: winner,
    epoch: 1, nodeId: '0.1', slots: {} }), /stale worker/);
});

test('emulator: prepared intent survives crash; uncertain effects require reconciliation', {
  skip: !enabled, timeout: 90_000,
}, async () => {
  let now = Date.now();
  const store = await setup(() => now);
  const first = await store.claim({ executionId: 'exec1', workerId: 'first', leaseMs: 1000 });
  await store.prepareEffect({ executionId: 'exec1', workerId: 'first',
    epoch: first.epoch, nodeId: '0.0', effectId: 'call_0', operation: 'http.post',
    args: { url: 'https://example.invalid' }, slots: {},
    continuation: { next_step: 1, slots: {}, frames: [] }, resultSlot: 's0' });
  const restored = new NativeExecutionStore({
    db, clock: () => now, collection: store.collection.id,
  });
  assert.equal((await restored.get('exec1')).pendingEffect.effectId, 'call_0');
  now += 1100;
  assert.equal((await restored.claim({ executionId: 'exec1',
    workerId: 'recovery', leaseMs: 5000 })).epoch, 2);
  let sent = 0;
  const noReconcile = new NativeEffectDispatcher({ handlers: {
    'http.post': async () => { sent++; return {}; },
  } });
  const uncertain = await noReconcile.dispatch({ store: restored,
    executionId: 'exec1', workerId: 'recovery', epoch: 2, effectId: 'call_0' });
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(sent, 0);
  const reconcile = new NativeEffectDispatcher({
    handlers: { 'http.post': async () => { sent++; return {}; } },
    reconcile: { 'http.post': async () => ({ confirmed: true }) },
  });
  const recorded = await reconcile.dispatch({ store: restored,
    executionId: 'exec1', workerId: 'recovery', epoch: 2, effectId: 'call_0' });
  assert.equal(recorded.status, 'reconciled');
  assert.equal(sent, 0);
  const state = await store.get('exec1');
  assert.equal(state.status, 'ready');
  assert.equal(state.pendingEffect, null);
  assert.equal(state.effectCount, 1);
  assert.equal(Object.hasOwn(state, 'effectResults'), false);
  assert.deepEqual((await restored.getEffect('exec1', 'call_0')).outcome,
    { confirmed: true });
  assert.deepEqual(state.checkpoint.slots.s0, {
    type: 'map', value: { confirmed: { type: 'bool', value: true } },
  });
  await assert.rejects(store.recordEffect({ executionId: 'exec1',
    workerId: 'first', epoch: 1, effectId: 'call_0', outcome: {} }), /stale worker/);
});

test('emulator: cancellation race cannot revive cancelled execution', {
  skip: !enabled, timeout: 90_000,
}, async () => {
  const store = await setup(() => Date.now());
  const { epoch } = await store.claim({ executionId: 'exec1', workerId: 'w' });
  await store.prepareEffect({ executionId: 'exec1', workerId: 'w', epoch,
    nodeId: '0.1', effectId: 'call_1', operation: 'http.post', args: {}, slots: {} });
  await Promise.allSettled([
    store.recordEffect({ executionId: 'exec1', workerId: 'w', epoch,
      effectId: 'call_1', outcome: { ok: true } }),
    store.cancel({ executionId: 'exec1', userId: 'owner', projectId: 'proj' }),
  ]);
  const state = await store.get('exec1');
  assert.equal(state.status, 'cancelled');
  assert.equal(state.owner, null);
  await assert.rejects(store.complete({ executionId: 'exec1', workerId: 'w',
    epoch, result: 1 }), /stale worker/);
});

const nativeBinary = process.env.AWFL_NATIVE_PROTOCOL_BINARY;
test('emulator + real generated Rust: persist suspension, dispatch mock effect, resume', {
  skip: !enabled || !nativeBinary, timeout: 90_000,
}, async () => {
  const sha256 = createHash('sha256').update(await readFile(nativeBinary)).digest('hex');
  const store = fixture();
  await store.create({ executionId: 'exec1', userId: 'owner', projectId: 'proj',
    artifactSha256: sha256, input: 9 });
  const args = { store, executionId: 'exec1', workerId: 'native_worker',
    executable: nativeBinary, sha256 };
  assert.deepEqual(await executeNativeStep(args), {
    status: 'waiting_effect', effectId: 'call_1',
  });
  const first = await store.get('exec1');
  assert.equal(first.checkpoint.next_step, 2);
  assert.deepEqual(first.checkpoint.slots.s0, { type: 'integer', value: 8 });
  let sent = 0;
  const dispatcher = new NativeEffectDispatcher({ handlers: {
    'http.post': async ({ idempotencyKey }) => {
      assert.equal(idempotencyKey, 'exec1:call_1');
      sent++;
      return 'server-recorded';
    },
  } });
  await dispatcher.dispatch({ store, executionId: 'exec1',
    workerId: 'native_worker', epoch: first.epoch, effectId: 'call_1' });
  assert.deepEqual((await store.get('exec1')).checkpoint.slots.s1,
    { type: 'string', value: 'server-recorded' });
  assert.deepEqual(await executeNativeStep(args), { status: 'completed', result: 'server-recorded' });
  assert.equal(sent, 1);
  assert.deepEqual(await executeNativeStep(args), { completed: true, result: 'server-recorded' });
});

const multiBinary = process.env.AWFL_NATIVE_MULTI_BINARY;
test('emulator + generated Rust: a replacement worker resumes a committed result', {
  skip: !enabled || !nativeBinary, timeout: 90_000,
}, async () => {
  let now = Date.now();
  const sha256 = createHash('sha256').update(await readFile(nativeBinary)).digest('hex');
  const store = fixture(() => now);
  await store.create({ executionId: 'exec1', userId: 'owner', projectId: 'proj',
    artifactSha256: sha256, input: 9 });
  const original = { store, executionId: 'exec1', workerId: 'crashed_worker',
    executable: nativeBinary, sha256 };
  assert.deepEqual(await executeNativeStep(original), {
    status: 'waiting_effect', effectId: 'call_1',
  });
  const prepared = await store.get('exec1');
  await store.recordEffect({ executionId: 'exec1', workerId: 'crashed_worker',
    epoch: prepared.epoch, effectId: 'call_1', outcome: 'before-crash' });
  now = prepared.leaseUntil + 1;
  const recoveredStore = new NativeExecutionStore({
    db, clock: () => now, collection: store.collection.id,
  });
  assert.deepEqual(await executeNativeStep({
    ...original, store: recoveredStore, workerId: 'replacement',
  }), { status: 'completed', result: 'before-crash' });
  const final = await recoveredStore.get('exec1');
  assert.equal(final.epoch, 2);
  assert.equal(final.effectCount, 1);
  assert.equal(final.pendingEffect, null);
  assert.deepEqual((await store.getEffect('exec1', 'call_1')).outcome,
    'before-crash');
});

test('emulator + real generated Rust: two effects each recorded exactly once', {
  skip: !enabled || !multiBinary, timeout: 90_000,
}, async () => {
  const sha256 = createHash('sha256').update(await readFile(multiBinary)).digest('hex');
  const store = fixture();
  await store.create({ executionId: 'exec1', userId: 'owner', projectId: 'proj',
    artifactSha256: sha256, input: null });
  const args = { store, executionId: 'exec1', workerId: 'native_worker',
    executable: multiBinary, sha256 };
  let sent = 0;
  const dispatcher = new NativeEffectDispatcher({ handlers: {
    'http.post': async ({ args: call, idempotencyKey }) => {
      assert.equal(idempotencyKey, 'exec1:call_' + sent);
      sent++;
      return call.url.split('/').at(-1);
    },
  } });
  for (const effectId of ['call_0', 'call_1']) {
    assert.deepEqual(await executeNativeStep(args), { status: 'waiting_effect', effectId });
    const { epoch } = await store.get('exec1');
    await dispatcher.dispatch({ store, executionId: 'exec1',
      workerId: 'native_worker', epoch, effectId });
  }
  assert.deepEqual(await executeNativeStep(args), { status: 'completed', result: 'second' });
  assert.equal(sent, 2);
  const completed = await store.get('exec1');
  assert.equal(completed.effectCount, 2);
  assert.equal(Object.hasOwn(completed, 'effectResults'), false);
  assert.deepEqual((await store.getEffect('exec1', 'call_0')).outcome, 'first');
  assert.deepEqual((await store.getEffect('exec1', 'call_1')).outcome, 'second');
});

const rangeBinary = process.env.AWFL_NATIVE_RANGE_BINARY;
test('emulator + generated Rust: framed range resumes without duplicating effects, even after takeover', {
  skip: !enabled || !rangeBinary, timeout: 90_000,
}, async () => {
  let now = Date.now();
  const sha256 = createHash('sha256').update(await readFile(rangeBinary)).digest('hex');
  const store = fixture(() => now);
  await store.create({ executionId: 'exec1', userId: 'owner', projectId: 'proj',
    artifactSha256: sha256, input: null });
  let workerId = 'original';
  const results = ['one', 'two', 'three'];
  let sent = 0;
  const dispatcher = new NativeEffectDispatcher({ handlers: {
    'http.post': async ({ idempotencyKey }) => {
      assert.match(idempotencyKey, new RegExp('^exec1:call_0_s[0-9]+_' + sent + '$'));
      return results[sent++];
    },
  } });
  for (let iteration = 0; iteration < results.length; iteration++) {
    const args = { store, executionId: 'exec1', workerId,
      executable: rangeBinary, sha256 };
    const pending = await executeNativeStep(args);
    assert.equal(pending.status, 'waiting_effect');
    assert.match(pending.effectId, new RegExp('^call_0_s[0-9]+_' + iteration + '$'));
    const state = await store.get('exec1');
    assert.equal(state.checkpoint.next_step, 0);
    assert.deepEqual(state.checkpoint.frames, [{ node_id: '0.0', iteration }]);
    assert.equal(state.checkpoint.slots.__awfl_loop_0_items.value.length, iteration);
    await dispatcher.dispatch({ store, executionId: 'exec1', workerId,
      epoch: state.epoch, effectId: pending.effectId });
    assert.deepEqual((await store.getEffect('exec1', pending.effectId)).outcome,
      results[iteration]);
    if (iteration === 1) {
      // Crash after a committed effect result; another worker must continue
      // from the last effect without redispatching either previous intent.
      now = state.leaseUntil + 1;
      workerId = 'replacement';
    }
  }
  assert.deepEqual(await executeNativeStep({ store, executionId: 'exec1', workerId,
    executable: rangeBinary, sha256 }), { status: 'completed', result: results });
  assert.equal(sent, 3);
  const done = await store.get('exec1');
  assert.equal(done.effectCount, 3);
  assert.equal(done.epoch, 2);
  assert.equal(done.pendingEffect, null);
});

const multiRangeBinary = process.env.AWFL_NATIVE_MULTI_RANGE_BINARY;
test('emulator + generated Rust: two dependent effects per range iteration survive worker takeover', {
  skip: !enabled || !multiRangeBinary, timeout: 90_000,
}, async () => {
  let now = Date.now();
  const sha256 = createHash('sha256').update(await readFile(multiRangeBinary)).digest('hex');
  const store = fixture(() => now);
  await store.create({ executionId: 'exec1', userId: 'owner', projectId: 'proj',
    artifactSha256: sha256, input: null });
  const ids = new Set();
  let sent = 0;
  let workerId = 'original';
  let firstSlot;
  const dispatcher = new NativeEffectDispatcher({ handlers: {
    'http.post': async ({ args, idempotencyKey }) => {
      const iteration = Math.floor(sent / 2);
      const site = sent % 2;
      assert.match(idempotencyKey, new RegExp('^exec1:call_0_s[0-9]+_' + iteration + '$'));
      if (site === 0) assert.deepEqual(args, { url: 'https://example.org/a' });
      else assert.equal(args, 'first-' + iteration);
      sent++;
      return (site === 0 ? 'first-' : 'second-') + iteration;
    },
  } });
  for (let iteration = 0; iteration < 2; iteration++) {
    for (let site = 0; site < 2; site++) {
      const args = { store, executionId: 'exec1', workerId,
        executable: multiRangeBinary, sha256 };
      const pending = await executeNativeStep(args);
      assert.equal(pending.status, 'waiting_effect');
      assert.equal(ids.has(pending.effectId), false);
      ids.add(pending.effectId);
      const state = await store.get('exec1');
      assert.equal(state.checkpoint.next_step, 0);
      assert.deepEqual(state.checkpoint.frames, [
        { node_id: '0.0', iteration },
        { node_id: state.pendingEffect.nodeId, iteration: site },
      ]);
      assert.equal(state.checkpoint.slots.__awfl_loop_0_items.value.length, iteration);
      if (site === 0) firstSlot = state.pendingEffect.resultSlot;
      else assert.deepEqual(state.checkpoint.slots[firstSlot],
        { type: 'string', value: 'first-' + iteration });
      await dispatcher.dispatch({ store, executionId: 'exec1', workerId,
        epoch: state.epoch, effectId: pending.effectId });
      // A crash immediately after committing the first result must not
      // repeat that effect when the replacement reaches the second Call.
      if (iteration === 0 && site === 0) {
        now = state.leaseUntil + 1;
        workerId = 'replacement';
      }
    }
  }
  assert.deepEqual(await executeNativeStep({ store, executionId: 'exec1', workerId,
    executable: multiRangeBinary, sha256 }),
  { status: 'completed', result: ['second-0', 'second-1'] });
  assert.equal(sent, 4);
  const done = await store.get('exec1');
  assert.equal(done.effectCount, 4);
  assert.equal(done.epoch, 2);
  assert.equal(done.pendingEffect, null);
  for (const effectId of ids) assert.notEqual(await store.getEffect('exec1', effectId), null);
});
