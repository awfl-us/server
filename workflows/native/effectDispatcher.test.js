import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeEffectDispatcher as BaseNativeEffectDispatcher } from './effectDispatcher.js';
import { NativeConfirmedHttpFailure } from './effectErrors.js';

const testAuthorize = async ({ userId, projectId }) => ({
  allowed: true, userId, projectId,
});
class NativeEffectDispatcher extends BaseNativeEffectDispatcher {
  constructor(options) { super({ ...options, authorizeExecution: testAuthorize }); }
}

const pending = { effectId: 'step1', operation: 'http.post', args: { url: 'https://example.test' }, preparedAt: 10 };
function fixture({ epoch = 1, updatedAt = 10, operation = 'http.post' } = {}) {
  const calls = [];
  const store = {
    get: async () => ({ owner: 'worker', userId: 'owner', projectId: 'project',
      epoch, leaseUntil: Date.now() + 60_000,
      updatedAt, pendingEffect: { ...pending, operation } }),
    recordEffect: async args => calls.push(args),
  };
  return { store, calls };
}

test('dispatcher requires an authorization policy and never calls denied handlers', async () => {
  assert.throws(() => new BaseNativeEffectDispatcher({
    handlers: { 'http.post': async () => 'should not run' },
  }), /requires an authorization policy/);
  const { store, calls } = fixture();
  let sent = 0;
  const denied = new BaseNativeEffectDispatcher({
    authorizeExecution: async () => null,
    handlers: { 'http.post': async () => { sent++; return 'sent'; } },
  });
  await assert.rejects(denied.dispatch({
    store, executionId: 'run1', workerId: 'worker', epoch: 1, effectId: 'step1',
  }), /not authorized/);
  assert.equal(sent, 0);
  assert.equal(calls.length, 0);
  const mismatched = new BaseNativeEffectDispatcher({
    authorizeExecution: async () => ({ allowed: true, userId: 'other', projectId: 'project' }),
    handlers: { 'http.post': async () => { sent++; return 'sent'; } },
  });
  await assert.rejects(mismatched.dispatch({
    store, executionId: 'run1', workerId: 'worker', epoch: 1, effectId: 'step1',
  }), /not authorized/);
  assert.equal(sent, 0);
});

test('authorization uses stored owner and aborts on lease changes before dispatch', async () => {
  const { store, calls } = fixture();
  let state = await store.get();
  const guarded = {
    ...store,
    get: async () => state,
  };
  let sent = 0;
  const dispatcher = new BaseNativeEffectDispatcher({
    authorizeExecution: async ({ userId, projectId, operation }) => {
      assert.deepEqual({ userId, projectId, operation }, {
        userId: 'owner', projectId: 'project', operation: 'http.post',
      });
      state = { ...state, epoch: 2 }; // simulates takeover during policy lookup
      return { allowed: true, userId, projectId };
    },
    handlers: { 'http.post': async () => { sent++; return 'sent'; } },
  });
  await assert.rejects(dispatcher.dispatch({
    store: guarded, executionId: 'run1', workerId: 'worker',
    epoch: 1, effectId: 'step1',
  }), /changed during authorization/);
  assert.equal(sent, 0);
  assert.equal(calls.length, 0);
});

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


test('only definitive HTTP failure enters a compiled Try; transport failure stays pending', async () => {
  const { store: base } = fixture();
  const actions = [];
  const store = {
    ...base,
    get: async () => ({ ...(await base.get()), pendingEffect: {
      ...pending, fingerprint: 'digest',
      onError: { nextStep: 7, errorSlot: 's2' },
    } }),
    recordEffectFailure: async args => actions.push(args),
  };
  const sent = new NativeEffectDispatcher({ handlers: {
    'http.post': async () => { throw new NativeConfirmedHttpFailure(503); },
  } });
  const outcome = await sent.dispatch({ store, executionId: 'run1', workerId: 'worker',
    epoch: 1, effectId: 'step1' });
  assert.equal(outcome.status, 'failed_recorded');
  assert.deepEqual(actions[0].failure, { message: 'HTTP 503', code: 503 });
  const uncertain = new NativeEffectDispatcher({ handlers: {
    'http.post': async () => { throw new Error('socket timeout'); },
  } });
  await assert.rejects(uncertain.dispatch({ store, executionId: 'run1', workerId: 'worker',
    epoch: 1, effectId: 'step1' }), /socket timeout/);
  assert.equal(actions.length, 1);
  const noHandler = { ...store, get: async () => ({ ...(await base.get()), pendingEffect: {
    ...pending, fingerprint: 'digest',
  } }) };
  await assert.rejects(sent.dispatch({ store: noHandler, executionId: 'run1',
    workerId: 'worker', epoch: 1, effectId: 'step1' }), /HTTP 503/);
  assert.equal(actions.length, 1);
});
