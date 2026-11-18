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

test('native Jobs effects route to a verified temporary project and retain the user', async () => {
  const requests = [], reads = [];
  const handlers = createJobsEffectHandlers({
    jobsOrigin: 'https://jobs.example.org',
    auth: { getIdTokenClient: async () => ({
      request: async request => {
        requests.push(request);
        return { status: 200, data: { success: true } };
      },
    }) },
    getProjectStorage: async () => ({
      get: async path => {
        reads.push(path);
        return path === 'users/verified-user/projects/temp'
          ? { data: { id: 'temp' } } : null;
      },
    }),
  });
  const args = {
    url: 'https://jobs.example.org/producer/start',
    headers: { 'x-user-id': 'attacker', 'x-project-id': 'temp' },
    body: { sessionId: 'session-1', userId: 'attacker', projectId: 'forged' },
    auth: { type: 'OIDC' },
  };
  const outcome = await handlers['http.post']({
    args, identity, idempotencyKey: 'native:some-effect',
  });
  assert.equal(outcome.code, 200);
  assert.deepEqual(reads, ['users/verified-user/projects/temp']);
  assert.equal(requests[0].headers['x-user-id'], 'verified-user');
  assert.equal(requests[0].headers['x-project-id'], 'temp');
  assert.deepEqual(requests[0].data, {
    sessionId: 'session-1', userId: 'verified-user', projectId: 'temp',
  });
  assert.equal(requests[0].headers.authorization, undefined);
  assert.deepEqual(identity, { userId: 'verified-user', projectId: 'project-a' });

  await assert.rejects(handlers['http.post']({
    args: { ...args, headers: { 'x-project-id': 'unowned' } },
    identity, idempotencyKey: 'native:some-effect-2',
  }), /not owned/);
  assert.equal(requests.length, 1, 'unauthorized effects cannot make IAM Jobs requests');
});

test('nested temporary project delivers registered parent callback in the parent scope', async () => {
  const requests = [];
  const root = 'native_' + 'a'.repeat(32);
  const callback = 'n' + 'b'.repeat(32);
  const path = 'users/verified-user/callbacks/' + callback;
  const handlers = createJobsEffectHandlers({
    jobsOrigin: 'https://jobs.example.org',
    callbackDb: {
      runTransaction: async () => { throw new Error('unexpected callback mutation'); },
      doc: requested => {
        assert.equal(requested, path);
        return { get: async () => ({ data: () => ({
          kind: 'native_workflow', created_by: 'verified-user',
          native_execution_id: root, native_project_id: 'project-a',
        }) }) };
      },
    },
    auth: { getIdTokenClient: async () => ({
      request: async request => {
        requests.push(request);
        return { status: 200, data: { ok: true } };
      },
    }) },
  });
  const input = {
    url: 'https://jobs.example.org/callbacks/' + callback,
    headers: { 'x-project-id': 'temporary-project' },
    body: { response: true }, auth: { type: 'OIDC' },
  };
  const result = await handlers['http.post']({
    args: input, identity, idempotencyKey: root + ':root:lane:child-step',
  });
  assert.equal(result.code, 200);
  assert.equal(requests[0].headers['x-project-id'], 'project-a');
  assert.equal(requests[0].data.projectId, 'project-a');
  assert.equal(requests[0].data.userId, 'verified-user');
  assert.deepEqual(input.headers, { 'x-project-id': 'temporary-project' });
  // Possession of a callback ID from another execution does not authorize
  // its invocation, even if the caller controls the project header.
  await assert.rejects(handlers['http.post']({
    args: input, identity,
    idempotencyKey: 'native_' + 'f'.repeat(32) + ':root:other-step',
  }), /does not belong to authenticated execution/);
  assert.equal(requests.length, 1);
});
