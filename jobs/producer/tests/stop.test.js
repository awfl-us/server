import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getApps, initializeApp } from 'firebase-admin/app';

if (!getApps().length) initializeApp({ projectId: 'awfl-stop-test' });
const { stopProjectConsumer } = await import('../stop.js');
const { stopByRuntime } = await import('../paths/stop.js');

const owner = { userId: 'owner', projectId: 'topaigents' };
const lock = { consumerId: 'active-consumer', runtime: {
  mode: 'gke', namespace: 'awfl', producerJobName: null,
  consumerJobName: 'consumer-active-consumer',
} };

test('producer and MCP share one shutdown path', async () => {
  const calls = [];
  const result = await stopProjectConsumer(owner, {
    getLock: async args => { calls.push(['getLock', args]); return { ok: true, lock }; },
    cancelProgress: args => { calls.push(['cancelProgress', args.projectId]); },
    stop: async args => {
      calls.push(['stop', args]);
      return { status: 200, body: { ok: true, released: true } };
    },
  });
  assert.deepEqual(calls.map(x => x[0]), ['getLock', 'cancelProgress', 'stop']);
  assert.deepEqual(calls[2][1], { ...owner, lock });
  assert.deepEqual(result, { status: 200, body: {
    ok: true, released: true, consumerStopped: true,
  } });
});

test('shared stop handles an absent lock without calling Kubernetes', async () => {
  let called = false;
  const result = await stopProjectConsumer(owner, {
    getLock: async () => ({ ok: true, lock: null }),
    cancelProgress: () => { called = true; },
    stop: async () => { called = true; },
  });
  assert.equal(called, false);
  assert.equal(result.body.consumerStopped, false);
  assert.equal(result.body.ok, true);
});

test('GKE shutdown deletes the real Job before releasing its matching lock', async () => {
  const steps = [];
  const result = await stopByRuntime({ ...owner, lock }, {
    deleteJob: async params => {
      steps.push(['delete', params]);
      return { ok: true, status: 200 };
    },
    setRuntime: async ({ consumerId }) => { steps.push(['runtime', consumerId]); },
    releaseLock: async params => {
      steps.push(['release', params]);
      return { ok: true, released: true };
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.deepEqual(steps.map(s => s[0]), ['delete', 'runtime', 'release']);
  assert.deepEqual(steps[0][1], { namespace: 'awfl', jobName: 'consumer-active-consumer' });
  assert.deepEqual(steps[2][1], { ...owner, consumerId: 'active-consumer' });
});

test('failed Kubernetes deletion must not release the lock', async () => {
  let released = false;
  const result = await stopByRuntime({ ...owner, lock }, {
    deleteJob: async () => ({ ok: false, status: 401 }),
    releaseLock: async () => { released = true; return { ok: true, released: true }; },
  });
  assert.equal(result.status, 503);
  assert.equal(result.body.ok, false);
  assert.match(result.body.error, /lock retained/);
  assert.equal(released, false);
});

test('missing runtime Job does not silently unlock a possibly running consumer', async () => {
  let released = false;
  const result = await stopByRuntime({ ...owner,
    lock: { consumerId: lock.consumerId, runtime: { mode: 'gke' } },
  }, {
    releaseLock: async () => { released = true; },
  });
  assert.equal(result.status, 409);
  assert.equal(released, false);
});

test('stop never clears a replacement consumer lock', async () => {
  const result = await stopByRuntime({ ...owner, lock }, {
    deleteJob: async () => ({ ok: true, status: 200 }),
    setRuntime: async () => {},
    releaseLock: async params => {
      assert.equal(params.consumerId, 'active-consumer');
      return { ok: false, conflict: true };
    },
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.ok, false);
});
