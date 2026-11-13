import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeAsyncScheduler } from './asyncScheduler.js';

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
