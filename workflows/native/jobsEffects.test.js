import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobsEffectHandlers } from './jobsEffects.js';

const identity = { userId: 'verified-user', projectId: 'project-a' };
test('native Jobs effects use server OIDC and ignore untrusted caller headers', async () => {
  const calls = [], audiences = [];
  const auth = {
    getIdTokenClient: async audience => {
      audiences.push(audience);
      return {
        request: async opts => {
          calls.push(opts);
          return { status: 200, data: { userId: opts.headers['x-user-id'] } };
        },
      };
    },
  };
  const handlers = createJobsEffectHandlers({
    jobsOrigin: 'https://jobs.example.org', auth,
  });
  const result = await handlers['http.post']({
    args: {
      url: 'https://jobs.example.org/agents/session/update',
      body: { value: 4, userId: 'forged' },
      headers: { 'x-user-id': 'forged', authorization: 'evil' },
      auth: { type: 'OIDC' },
    },
    idempotencyKey: 'native:call_0', identity,
  });
  assert.deepEqual(result, { code: 200, body: { userId: 'verified-user' } });
  assert.deepEqual(audiences, ['https://jobs.example.org']);
  assert.equal(calls[0].headers['x-user-id'], 'verified-user');
  assert.equal(calls[0].headers['x-project-id'], 'project-a');
  assert.deepEqual(calls[0].data, {
    value: 4, userId: 'verified-user', projectId: 'project-a',
  });
  assert.equal(calls[0].headers.authorization, undefined);
  assert.equal(calls[0].maxRedirects, 0);
});

test('native Jobs effects reject external URLs and caller-supplied auth', async () => {
  let called = 0;
  const handlers = createJobsEffectHandlers({
    jobsOrigin: 'https://jobs.example.org',
    auth: { getIdTokenClient: async () => {
      called++;
      return { request: async () => ({ status: 200, data: {} }) };
    } },
  });
  for (const [url, auth] of [
    ['https://attacker.example.org/jobs', undefined],
    ['https://user:password@jobs.example.org/jobs', undefined],
    ['http://jobs.example.org/jobs', undefined],
    ['https://jobs.example.org.evil.com/jobs', undefined],
    ['https://jobs.example.org/jobs', { type: 'OAuth2' }],
  ]) {
    await assert.rejects(handlers['http.post']({
      args: { url, ...(auth && { auth }) },
      identity, idempotencyKey: 'native:call_0',
    }));
  }
  assert.equal(called, 0);
});
