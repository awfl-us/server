import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeAsyncScheduler, needsNativeEffectReconciliation } from './asyncScheduler.js';

const a = 'native_' + 'a'.repeat(32);
const b = 'native_' + 'b'.repeat(32);
const c = 'native_' + 'c'.repeat(32);
const owner = { userId: 'user', projectId: 'project' };

test('detached queue returns immediately, deduplicates, bounds concurrency and drains', async () => {
  const calls = [], resolves = [];
  const scheduler = createNativeAsyncScheduler({
    store: { get: async () => null },
    execute: async request => {
      calls.push(request);
      await new Promise(resolve => resolves.push(resolve));
    },
    concurrency: 2,
  });
  scheduler.enqueue({ executionId: a, ...owner });
  scheduler.enqueue({ executionId: a, ...owner });
  scheduler.enqueue({ executionId: b, ...owner });
  scheduler.enqueue({ executionId: c, ...owner });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2, 'only two concurrent workers');
  assert.equal(scheduler.queuedCount, 1);
  resolves.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 3);
  resolves.shift()();
  resolves.shift()();
  await scheduler.drain();
  assert.equal(scheduler.activeCount, 0);
  await scheduler.close();
  assert.throws(() => scheduler.enqueue({ executionId: a, ...owner }), /invalid/);
});

test('scanner recovers only unleased, nonterminal detached executions', async () => {
  const calls = [];
  const now = Date.now();
  const scheduler = createNativeAsyncScheduler({
    store: {
      get: async () => null,
      listPendingAsync: async () => [
        { executionId: a, ...owner, asyncLaunch: true,
          status: 'ready', owner: null, leaseUntil: 0 },
        { executionId: b, ...owner, asyncLaunch: true,
          status: 'running', owner: 'other', leaseUntil: now + 60_000 },
        { executionId: c, ...owner, asyncLaunch: true,
          status: 'waiting_effect', owner: 'old', leaseUntil: now - 10_000 },
      ],
    },
    execute: async request => { calls.push(request); },
  });
  await scheduler.scan();
  await scheduler.drain();
  assert.deepEqual(calls.map(x => x.executionId).sort(), [a, c]);
  await scheduler.close();
});

test('no unobserved rejection when a detached execution fails, and queue continues', async () => {
  const failures = [], successes = [];
  const scheduler = createNativeAsyncScheduler({
    store: { get: async () => null },
    concurrency: 1,
    logError: error => failures.push(error.message),
    execute: async ({ executionId }) => {
      if (executionId === a) throw new Error('simulated transient child failure');
      successes.push(executionId);
    },
  });
  scheduler.enqueue({ executionId: a, ...owner });
  scheduler.enqueue({ executionId: b, ...owner });
  await scheduler.drain();
  assert.deepEqual(failures, ['simulated transient child failure']);
  assert.deepEqual(successes, [b]);
  await scheduler.close();
});

test('recovery prioritizes new ready children over more than 100 stale HTTP intents', async () => {
  const calls = [];
  let requestedLimit;
  const now = Date.now();
  const stale = Array.from({length: 130}, (_, i) => ({
    executionId: 'native_' + String(i).padStart(32, '0'),
    ...owner, asyncLaunch: true, status: 'waiting_effect',
    epoch: 13, owner: 'expired', leaseUntil: now - 20_000,
    updatedAt: now - 1000,
    pendingEffect: {operation: 'http.post', preparedAt: now - 60_000},
  }));
  const scheduler = createNativeAsyncScheduler({
    store: {
      get: async () => null,
      listPendingAsync: async limit => {
        requestedLimit = limit;
        return [...stale, {executionId: a, ...owner, asyncLaunch: true,
          status: 'ready', epoch: 0, owner: null, leaseUntil: 0}];
      },
    },
    execute: async request => { calls.push(request.executionId); },
  });
  await scheduler.scan();
  await scheduler.drain();
  assert.equal(requestedLimit, 500);
  assert.deepEqual(calls, [a], 'stale network requests cannot starve a new child');
  await scheduler.close();
});

test('only old unresolved remote intents are quarantined', () => {
  const now = Date.now();
  const base = {status: 'waiting_effect', updatedAt: now,
    pendingEffect: {operation: 'http.post', preparedAt: now - 3000}};
  assert.equal(needsNativeEffectReconciliation({...base, epoch: 1}), false,
    'first claimed HTTP effect remains dispatchable');
  assert.equal(needsNativeEffectReconciliation({...base, epoch: 2}), true,
    'reclaimed unjournaled HTTP effects need reconciliation');
  assert.equal(needsNativeEffectReconciliation({...base, epoch: 2,
    pendingEffect: {operation: 'native.parallel', preparedAt: now - 3000}}), false,
    'native.parallel has a deterministic reconciliation handler');
  assert.equal(needsNativeEffectReconciliation({...base, epoch: 2,
    pendingEffect: {operation: 'log.write', preparedAt: now - 3000}}), false);
  assert.equal(needsNativeEffectReconciliation({...base, epoch: 2,
    updatedAt: now - 6000}), false,
    'an effect prepared after the last update is not stale');
});


test('recovery scanners filter pending records by their persisted mode', async () => {
  const recorded = [];
  const states = [
    { executionId: a, ...owner, asyncLaunch: true,
      status: 'ready', leaseUntil: 0 },
    { executionId: b, ...owner, asyncLaunch: true,
      executionMode: 'memory', status: 'ready', leaseUntil: 0 },
  ];
  const store = { get: async () => null, listPendingAsync: async () => states };
  const memory = createNativeAsyncScheduler({ store,
    shouldRecover: state => state.executionMode === 'memory',
    execute: async ({ executionId }) => recorded.push(['memory', executionId]),
  });
  const durable = createNativeAsyncScheduler({ store,
    shouldRecover: state => state.executionMode !== 'memory',
    execute: async ({ executionId }) => recorded.push(['durable', executionId]),
  });
  try {
    await Promise.all([memory.scan(), durable.scan()]);
    await Promise.all([memory.drain(), durable.drain()]);
    assert.deepEqual(recorded.sort((x, y) => x[1].localeCompare(y[1])), [
      ['durable', a], ['memory', b],
    ]);
  } finally { await Promise.all([memory.close(), durable.close()]); }
});
