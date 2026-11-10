import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeEffectDispatcher } from './effectDispatcher.js';

const pending = { effectId: 'step1', operation: 'http.post', args: { url: 'https://example.test' }, preparedAt: 10 };
function fixture({ epoch = 1, updatedAt = 10, operation = 'http.post' } = {}) {
  const calls = [];
  const store = {
    get: async () => ({ owner: 'worker', epoch, leaseUntil: Date.now() + 60_000,
      updatedAt, pendingEffect: { ...pending, operation } }),
    recordEffect: async args => calls.push(args),
  };
  return { store, calls };
}

test('dispatches allowed operation once with stable idempotency key', async () => {
  const { store, calls } = fixture();
  let key;
  const dispatcher = new NativeEffectDispatcher({ handlers: { 'http.post': async ({ idempotencyKey }) => {
    key = idempotencyKey; return { status: 201 };
  } } });
  const result = await dispatcher.dispatch({ store, executionId: 'run1', workerId: 'worker', epoch: 1, effectId: 'step1' });
  assert.equal(key, 'run1:step1');
  assert.equal(result.status, 'recorded');
  assert.equal(calls.length, 1);
});

test('recovered effect without reconciliation remains uncertain and is not dispatched', async () => {
  const { store, calls } = fixture({ epoch: 2, updatedAt: 20 });
  let invoked = false;
  const dispatcher = new NativeEffectDispatcher({ handlers: { 'http.post': async () => { invoked = true; } } });
  const result = await dispatcher.dispatch({ store, executionId: 'run1', workerId: 'worker', epoch: 2, effectId: 'step1' });
  assert.equal(result.status, 'uncertain');
  assert.equal(invoked, false);
  assert.equal(calls.length, 0);
});

test('reconciliation records observed outcome without repeating remote effect', async () => {
  const { store, calls } = fixture({ epoch: 2, updatedAt: 20 });
  const dispatcher = new NativeEffectDispatcher({ handlers: { 'http.post': () => { throw new Error('must not call'); } },
    reconcile: { 'http.post': async () => ({ status: 200 }) } });
  const result = await dispatcher.dispatch({ store, executionId: 'run1', workerId: 'worker', epoch: 2, effectId: 'step1' });
  assert.equal(result.status, 'reconciled');
  assert.equal(calls.length, 1);
});

test('unknown operations fail closed and transport failures leave intent unresolved', async () => {
  const unknown = fixture({ operation: 'sys.shell' });
  const dispatcher = new NativeEffectDispatcher({ handlers: { 'http.post': async () => { throw new Error('timeout'); } } });
  await assert.rejects(dispatcher.dispatch({ store: unknown.store, executionId: 'run1', workerId: 'worker', epoch: 1, effectId: 'step1' }), /not allowed/);
  const normal = fixture();
  await assert.rejects(dispatcher.dispatch({ store: normal.store, executionId: 'run1', workerId: 'worker', epoch: 1, effectId: 'step1' }), /timeout/);
  assert.equal(normal.calls.length, 0);
});
