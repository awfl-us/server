import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getApps, initializeApp } from 'firebase-admin/app';
if (!getApps().length) initializeApp({ projectId: 'awfl-shared-consumer-test' });
const { ensureProjectConsumer } = await import('../start.js');

test('MCP attaches when normal producer already holds project lock; no new Job', async () => {
  let started = false;
  const result = await ensureProjectConsumer({ userId: 'owner', projectId: 'one-project' }, {
    getLock: async () => ({ lock: { consumerId: 'regular-consumer', expiresAt: Date.now() + 60000 } }),
    start: async () => { started = true; throw Error('must not launch'); },
  });
  assert.deepEqual(result, { state: 'attached', consumerId: 'regular-consumer' });
  assert.equal(started, false);
});

test('MCP starts the same producer lifecycle only when no project consumer exists', async () => {
  const calls = [];
  const result = await ensureProjectConsumer({ userId: 'owner', projectId: 'one-project' }, {
    getLock: async () => ({ lock: null }),
    start: async args => {
      calls.push(args);
      return { status: 202, body: { ok: true, consumerId: 'consumer-123' } };
    },
  });
  assert.deepEqual(result, { state: 'starting', consumerId: 'consumer-123' });
  assert.deepEqual(calls, [{ userId: 'owner', projectId: 'one-project' }]);
});

test('lock contention during startup reuses other client instead of creating a parallel job', async () => {
  const result = await ensureProjectConsumer({ userId: 'owner', projectId: 'one-project' }, {
    getLock: async () => ({ lock: null }),
    start: async () => ({ status: 202, body: {
      message: 'Lock held by another consumer', details: { holder: { consumerId: 'winner' } },
    } }),
  });
  assert.deepEqual(result, { state: 'attached', consumerId: 'winner' });
});

test('failed project startup propagates and does not create an orphan MCP attachment', async () => {
  await assert.rejects(ensureProjectConsumer({ userId: 'owner', projectId: 'one-project' }, {
    getLock: async () => ({ lock: null }),
    start: async () => ({ status: 500, body: { error: 'GKE unavailable' } }),
  }), /GKE unavailable/);
});

test('MCP passes a selected Scala profile through the existing project startup path', async () => {
  const calls = [];
  const result = await ensureProjectConsumer({ userId: 'owner', projectId: 'repo', imageProfile: 'scala' }, {
    getLock: async () => ({ lock: null }),
    start: async args => {
      calls.push(args);
      return { status: 202, body: { ok: true, consumerId: 'scala-consumer', imageProfile: 'scala' } };
    },
  });
  assert.deepEqual(calls, [{ userId: 'owner', projectId: 'repo', body: { imageProfile: 'scala' } }]);
  assert.deepEqual(result, { state: 'starting', consumerId: 'scala-consumer', imageProfile: 'scala' });
});

test('cannot silently switch images on an already running shared project consumer', async () => {
  let started = false;
  await assert.rejects(ensureProjectConsumer({ userId: 'owner', projectId: 'repo', imageProfile: 'scala' }, {
    getLock: async () => ({ lock: { consumerId: 'browser-consumer', expiresAt: Date.now() + 60000,
      runtime: { imageProfile: 'browser' } } }),
    start: async () => { started = true; },
  }), /stop it before choosing scala/);
  assert.equal(started, false);
});
