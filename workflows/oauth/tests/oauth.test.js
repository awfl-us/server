import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createHash } from 'node:crypto';
import { createMcpOAuthRouter } from '../router.js';
import { API_RESOURCE, MCP_RESOURCES, OAUTH_ISSUER, mintAccessToken, verifyAccessToken, pkceChallenge } from '../core.js';
import { createMcpRouter } from '../../../mcp/index.js';
import { createAgentsMcpRouter } from '../../../agentsMcp/index.js';
import { clientAuth } from '../../userAuth.js';
import { resolveAwflIdentity } from '../../auth/identity.js';

function memoryDb() {
  const records = new Map();
  const doc = path => ({
    async get() {
      const value = records.get(path);
      return { exists: value !== undefined, data: () => value };
    },
    async create(value) {
      if (records.has(path)) throw new Error('already exists');
      records.set(path, structuredClone(value));
    },
    async delete() { records.delete(path); },
  });
  return {
    records,
    collection: name => ({ doc: id => doc(name + '/' + id) }),
    async runTransaction(action) {
      const queued = [];
      const result = await action({
        get: ref => ref.get(),
        create: (ref, val) => queued.push(() => ref.create(val)),
        delete: ref => queued.push(() => ref.delete()),
      });
      for (const op of queued) await op();
      return result;
    },
  };
}
async function start() {
  const db = memoryDb();
  const app = express();
  app.use(express.json());
  const service = {
    isOwner: async uid => uid === 'owner',
    invoke: async (uid, name) => ({ uid, name }),
    listProjects: async uid => ({ uid, projects: [] }),
  };
  app.use(createMcpOAuthRouter({
    db,
    verifyFirebaseToken: async token => ({ uid: token === 'owner-token' ? 'owner' : 'other' }),
  }));
  app.use('/mcp/agents', createAgentsMcpRouter({
    executionService: service,
    sessionService: { listAgents: async uid => ({ uid, agents: [] }) },
  }));
  app.use('/mcp', createMcpRouter(service));
  app.get('/api/identity-test', clientAuth, (req, res) => res.json({ userId: req.userId, method: req.authMethod }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return {
    base: 'http://127.0.0.1:' + server.address().port,
    db, close: () => new Promise(resolve => server.close(resolve)),
  };
}
async function json(response) {
  const body = await response.json();
  return { status: response.status, body, headers: response.headers };
}
function form(body) {
  return { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body) };
}
const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
const verifier = 'this-is-a-valid-PKCE-verifier-with-at-least-forty-three-chars';
const secret = 'AWFL-test-secret-is-64-bytes-long-and-never-used-in-production!';

test('AWFL OAuth access token is signed, expired correctly, and audience-bound to the API', () => {
  const now = Date.UTC(2026, 10, 10, 0, 0, 0);
  const token = mintAccessToken({
    userId: 'owner', clientId: 'public-client', resource: MCP_RESOURCES.agents,
    secret, now,
  });
  assert.equal(verifyAccessToken(token, { resource: API_RESOURCE, secret, now }).userId, 'owner');
  assert.equal(verifyAccessToken(token, { resource: API_RESOURCE, secret, now }).userId, 'owner');
  assert.equal(verifyAccessToken(token, { secret, now }).userId, 'owner');
  assert.equal(verifyAccessToken(token, { resource: API_RESOURCE, secret, now: now + 901000 }), null);
  assert.equal(verifyAccessToken(token.slice(0, -2) + 'xx', { resource: API_RESOURCE, secret, now }), null);
  const [header, payload] = token.split('.');
  const contents = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  assert.equal(contents.aud, API_RESOURCE);
  assert.equal(verifyAccessToken(header + '.' + Buffer.from(JSON.stringify({ ...contents, sub: 'other' })).toString('base64url') + '.' + token.split('.')[2],
    { resource: API_RESOURCE, secret, now }), null);
});

test('ChatGPT DCR, login consent, PKCE, token exchange, refresh and BOTH MCPs', async () => {
  const previous = process.env.ENCRYPTION_SECRET_KEY;
  process.env.ENCRYPTION_SECRET_KEY = secret;
  const app = await start();
  try {
    for (const [suffix, expected] of [
      ['/.well-known/oauth-protected-resource/mcp', MCP_RESOURCES.terminal],
      ['/.well-known/oauth-protected-resource/mcp/agents', MCP_RESOURCES.agents],
    ]) {
      const r = await json(await fetch(app.base + suffix));
      assert.equal(r.status, 200);
      assert.equal(r.body.resource, API_RESOURCE);
      assert.deepEqual(r.body.authorization_servers, [OAUTH_ISSUER]);
    }
    const issuer = await json(await fetch(app.base + '/.well-known/oauth-authorization-server'));
    assert.equal(issuer.body.code_challenge_methods_supported[0], 'S256');
    assert.equal(issuer.body.client_id_metadata_document_supported, true);
    const rejectedRegister = await json(await fetch(app.base + '/oauth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://evil.example/steal'] }),
    }));
    assert.equal(rejectedRegister.status, 400);
    const registered = await json(await fetch(app.base + '/oauth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }),
    }));
    assert.equal(registered.status, 201);
    const clientId = registered.body.client_id;
    const authorize = new URL(app.base + '/oauth/authorize');
    for (const [name, value] of Object.entries({
      client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
      state: 'chatgpt-local-state', resource: API_RESOURCE,
      scope: 'awfl:access', code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
    })) authorize.searchParams.set(name, value);
    const startResponse = await fetch(authorize, { redirect: 'manual' });
    assert.equal(startResponse.status, 302);
    const consentUri = new URL(startResponse.headers.get('location'));
    assert.equal(consentUri.origin, 'https://awfl.us');
    const requestId = consentUri.searchParams.get('request');
    assert.ok(requestId);

    const unauthorized = await json(await fetch(app.base + '/oauth/requests/' + requestId, {
      headers: { Authorization: 'Bearer other-token' },
    }));
    assert.equal(unauthorized.status, 200);
    const authorized = await json(await fetch(app.base + '/oauth/requests/' + requestId, {
      headers: { Authorization: 'Bearer owner-token' },
    }));
    assert.equal(authorized.body.resource, API_RESOURCE);

    const decision = await json(await fetch(app.base + '/oauth/decide', {
      method: 'POST',
      headers: { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: requestId, approve: true }),
    }));
    assert.equal(decision.status, 200);
    const callback = new URL(decision.body.redirect_url);
    assert.equal(callback.origin, 'https://chatgpt.com');
    assert.equal(callback.searchParams.get('state'), 'chatgpt-local-state');
    assert.equal(callback.searchParams.get('iss'), OAUTH_ISSUER);
    const code = callback.searchParams.get('code');
    const grant = {
      client_id: clientId, redirect_uri: redirectUri, grant_type: 'authorization_code',
      code, code_verifier: verifier, resource: API_RESOURCE,
    };
    const wrongVerifier = await json(await fetch(app.base + '/oauth/token',
      form({ ...grant, code_verifier: verifier + 'wrong' })));
    assert.equal(wrongVerifier.status, 400);
    assert.equal(wrongVerifier.body.error, 'invalid_grant');
    const wrongResource = await json(await fetch(app.base + '/oauth/token',
      form({ ...grant, resource: 'https://evil.example.net' })));
    assert.equal(wrongResource.status, 400);
    const exchanged = await json(await fetch(app.base + '/oauth/token', form(grant)));
    assert.equal(exchanged.status, 200);
    assert.equal(exchanged.body.token_type, 'Bearer');
    assert.equal(exchanged.body.expires_in, 900);
    assert.ok(exchanged.body.refresh_token);

    const apiIdentity = await json(await fetch(app.base + '/api/identity-test', {
      headers: { Authorization: 'Bearer ' + exchanged.body.access_token },
    }));
    assert.equal(apiIdentity.status, 200);
    assert.deepEqual(apiIdentity.body, { userId: 'owner', method: 'oauth' });
    assert.deepEqual(await resolveAwflIdentity('firebase-id-token', {
      verifyFirebaseToken: async () => ({ uid: 'owner' }),
    }), { userId: 'owner', method: 'firebase' });
    const otherToken = mintAccessToken({
      userId: 'other', clientId, resource: API_RESOURCE, secret,
    });
    const otherApi = await json(await fetch(app.base + '/api/identity-test', {
      headers: { Authorization: 'Bearer ' + otherToken },
    }));
    assert.deepEqual(otherApi.body, { userId: 'other', method: 'oauth' });
    for (const path of ['/mcp', '/mcp/agents']) {
      const denied = await fetch(app.base + path, {
        method: 'POST', headers: { Authorization: 'Bearer ' + otherToken },
      });
      assert.equal(denied.status, 403, path + ' enforces its original owner policy');
    }
    const reused = await json(await fetch(app.base + '/oauth/token', form(grant)));
    assert.equal(reused.status, 400);
    assert.equal(reused.body.error, 'invalid_grant');

    for (const path of ['/mcp', '/mcp/agents']) {
      const unauthorizedMcp = await fetch(app.base + path, {
        method: 'POST', headers: { Authorization: 'Bearer ' + exchanged.body.access_token + 'tampered' },
      });
      assert.equal(unauthorizedMcp.status, 401);
      assert.match(unauthorizedMcp.headers.get('www-authenticate'), /resource_metadata=/);
      const response = await fetch(app.base + path, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + exchanged.body.access_token,
          'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
        }),
      });
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.ok(data.result.tools.length > 0);
    }
    const refreshed = await json(await fetch(app.base + '/oauth/token', form({
      client_id: clientId, grant_type: 'refresh_token',
      refresh_token: exchanged.body.refresh_token,
      resource: API_RESOURCE,
    })));
    assert.equal(refreshed.status, 200);
    assert.notEqual(refreshed.body.access_token, exchanged.body.access_token);
    const replay = await json(await fetch(app.base + '/oauth/token', form({
      client_id: clientId, grant_type: 'refresh_token',
      refresh_token: exchanged.body.refresh_token,
      resource: API_RESOURCE,
    })));
    assert.equal(replay.status, 400);
    assert.equal(replay.body.error, 'invalid_grant');
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.ENCRYPTION_SECRET_KEY;
    else process.env.ENCRYPTION_SECRET_KEY = previous;
  }
});
