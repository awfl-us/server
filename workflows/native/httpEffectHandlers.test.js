import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeHttpEffectHandlers } from './httpEffectHandlers.js';
import { NativeConfirmedHttpFailure } from './effectErrors.js';
import { NativeEffectDispatcher } from './effectDispatcher.js';

const targets = [{
  origin: 'https://api.example.org',
  pathPrefixes: ['/v1/'],
  methods: ['GET', 'POST', 'PATCH'],
  authentication: 'bearer',
}];
const identity = { userId: 'owner', projectId: 'project' };
const idempotencyKey = 'exec1:call_0';
const request = (args, operation = 'http.post') => ({
  args, identity, idempotencyKey, operation,
});

test('native HTTP handlers require configured transport, HTTPS targets and credential provider', () => {
  assert.throws(() => createNativeHttpEffectHandlers({
    targets, transport: {},
  }), /restricted native HTTP transport/);
  assert.throws(() => createNativeHttpEffectHandlers({
    targets, transport: { sendRequest: async () => ({}) },
  }), /trusted native credential provider/);
  for (const origin of ['http://api.example.org', 'https://127.0.0.1',
    'https://localhost', 'https://api.example.org:9443',
    'https://api.example.org/private', 'https://user:password@api.example.org']) {
    assert.throws(() => createNativeHttpEffectHandlers({
      targets: [{ ...targets[0], origin }],
      transport: { sendRequest: async () => ({}) },
      credentialProvider: async () => 'token',
    }), /public HTTPS DNS origin/);
  }
  assert.throws(() => createNativeHttpEffectHandlers({
    targets: [{ ...targets[0], pathPrefixes: ['/v1/../'] }],
    transport: { sendRequest: async () => ({}) },
    credentialProvider: async () => 'token',
  }), /invalid native HTTP target policy/);
});

test('authorized policy sends only approved URL/method and trusted credentials', async () => {
  const requests = [];
  const credentials = [];
  const handlers = createNativeHttpEffectHandlers({
    targets,
    credentialProvider: async ctx => {
      credentials.push(ctx);
      return 'short-lived-service-token';
    },
    transport: {
      sendRequest: async ctx => {
        requests.push(ctx);
        return { status: 201, body: { stored: true } };
      },
    },
  });
  assert.deepEqual(await handlers['http.post'](request({
    url: 'https://api.example.org/v1/jobs?id=1', body: { task: 'test' },
  })), { code: 201, body: { stored: true } });
  assert.deepEqual(credentials, [{
    origin: 'https://api.example.org', method: 'POST',
    userId: 'owner', projectId: 'project',
  }]);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    url: 'https://api.example.org/v1/jobs?id=1',
    method: 'POST',
    body: '{"task":"test"}',
    headers: {
      accept: 'application/json',
      'x-awfl-idempotency-key': idempotencyKey,
      'content-type': 'application/json',
      authorization: 'Bearer short-lived-service-token',
    },
    timeoutMs: 10_000, redirect: 'error', credentials: 'omit',
    maxResponseBytes: 128 * 1024,
  });
});

test('URL, method, identity and header smuggling are rejected before network dispatch', async () => {
  let sent = 0;
  let tokens = 0;
  const handlers = createNativeHttpEffectHandlers({
    targets,
    credentialProvider: async () => { tokens++; return 'token'; },
    transport: { sendRequest: async () => {
      sent++;
      return { status: 200, body: { ok: true } };
    } },
  });
  const attempts = [
    { url: 'http://api.example.org/v1/jobs' },
    { url: 'https://evil.example.org/v1/jobs' },
    { url: 'https://127.0.0.1/v1/jobs' },
    { url: 'https://api.example.org/admin' },
    { url: 'https://me:pass@api.example.org/v1/jobs' },
    { url: 'https://api.example.org:8080/v1/jobs' },
    { url: 'https://api.example.org/v1/%2fadmin' },
    { url: 'https://api.example.org/v1/jobs', headers: { Authorization: 'evil' } },
    { url: 'https://api.example.org/v1/jobs', auth: 'unsafe' },
    { url: 'https://api.example.org/v1/jobs', body: 'x'.repeat(140_000) },
  ];
  for (const args of attempts) {
    await assert.rejects(handlers['http.post'](request(args)));
  }
  await assert.rejects(handlers['http.delete'](request({
    url: 'https://api.example.org/v1/jobs',
  })), /not permitted/);
  await assert.rejects(handlers['http.get'](request({
    url: 'https://api.example.org/v1/jobs', body: {},
  })), /does not permit a body/);
  await assert.rejects(handlers['http.post']({
    args: { url: 'https://api.example.org/v1/jobs' },
    identity: { userId: '', projectId: 'project' }, idempotencyKey,
  }), /identity/);
  assert.equal(sent, 0);
  assert.equal(tokens, 0);
});

test('redirects, HTTP errors, bad server credentials and oversized outcomes fail closed', async () => {
  let status = 302;
  let responseBody = {};
  let token = 'trusted';
  const handlers = createNativeHttpEffectHandlers({
    targets,
    credentialProvider: async () => token,
    transport: { sendRequest: async () => ({ status, body: responseBody }) },
  });
  const args = { url: 'https://api.example.org/v1/jobs' };
  await assert.rejects(handlers['http.post'](request(args)), /error or redirect/);
  status = 503;
  await assert.rejects(handlers['http.post'](request(args)),
    error => error instanceof NativeConfirmedHttpFailure && error.status === 503);
  status = 403;
  await assert.rejects(handlers['http.post'](request(args)),
    error => error instanceof NativeConfirmedHttpFailure && error.status === 403);
  status = 200;
  responseBody = { bulk: 'x'.repeat(140_000) };
  await assert.rejects(handlers['http.post'](request(args)), /response body too large/);
  token = 'untrusted\nheader';
  responseBody = {};
  await assert.rejects(handlers['http.post'](request(args)), /server credential/);
});

test('authorized dispatcher and guarded HTTP handler compose without revealing policy secrets', async () => {
  const sent = [];
  const handlers = createNativeHttpEffectHandlers({
    targets,
    credentialProvider: async () => 'service-token',
    transport: { sendRequest: async ctx => {
      sent.push(ctx);
      return { status: 200, body: { created: true } };
    } },
  });
  const saved = [];
  const pendingEffect = {
    effectId: 'call_0', operation: 'http.post',
    args: { url: 'https://api.example.org/v1/jobs', body: { task: true } },
    preparedAt: Date.now(), fingerprint: 'digest',
  };
  const store = {
    get: async () => ({
      owner: 'worker', epoch: 1, leaseUntil: Date.now() + 60_000,
      userId: 'owner', projectId: 'project', pendingEffect,
    }),
    recordEffect: async value => saved.push(value),
  };
  const dispatcher = new NativeEffectDispatcher({
    handlers,
    authorizeExecution: async context => ({
      allowed: true,
      userId: context.userId, projectId: context.projectId,
      privateCredential: 'not-for-handlers',
    }),
  });
  assert.deepEqual(await dispatcher.dispatch({
    store, executionId: 'exec1', workerId: 'worker', epoch: 1, effectId: 'call_0',
  }), {
    status: 'recorded', effectId: 'call_0',
    outcome: { code: 200, body: { created: true } },
  });
  assert.equal(saved.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(JSON.stringify(sent).includes('not-for-handlers'), false);
});
