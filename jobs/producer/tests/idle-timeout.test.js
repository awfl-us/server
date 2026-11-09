import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getApps, initializeApp } from 'firebase-admin/app';
if (!getApps().length) initializeApp({ projectId: 'awfl-idle-timeout-test' });
const { resolveIdleTimeoutSeconds } = await import('../idleTimeout.js');
const { ensureProjectConsumer } = await import('../start.js');

test('cloud idle defaults to one hour and enforces 60 seconds to 24 hours', () => {
  assert.equal(resolveIdleTimeoutSeconds(undefined, undefined), 3600);
  assert.equal(resolveIdleTimeoutSeconds(90), 90);
  assert.equal(resolveIdleTimeoutSeconds(undefined, '600'), 600);
  for (const invalid of [0, -1, 59, 86401, 1.1, 'invalid', '']) {
    assert.throws(() => resolveIdleTimeoutSeconds(invalid), /idleTimeoutSeconds/);
  }
});

test('new consumer accepts override, existing shared consumer retains its own timeout', async () => {
  const calls = [];
  const start = async args => {
    calls.push(args);
    return { status: 202, body: { ok: true, consumerId: 'launched' } };
  };
  await ensureProjectConsumer({ userId: 'owner', projectId: 'repo', idleTimeoutSeconds: 1800 }, {
    getLock: async () => ({ lock: null }), start,
  });
  assert.deepEqual(calls, [{ userId: 'owner', projectId: 'repo', body: { idleTimeoutSeconds: 1800 } }]);
  await ensureProjectConsumer({ userId: 'owner', projectId: 'repo', idleTimeoutSeconds: 1800 }, {
    getLock: async () => ({ lock: { consumerId: 'existing', expiresAt: Date.now() + 60000 } }), start,
  });
  assert.equal(calls.length, 1);
});
