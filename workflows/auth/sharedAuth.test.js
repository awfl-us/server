import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { generateApiKey, API_SCOPE, MCP_SCOPE } from '../apiKeys/core.js';
import { verifyAwflApiKey } from '../apiKeys/verify.js';
import { resolveAwflIdentity } from './identity.js';
import { createClientAuth } from '../userAuth.js';
import { privateMcpMiddleware, requireMcpCredential } from '../../mcp/privateAuth.js';
import { MCP_RESOURCES } from '../oauth/core.js';

function fakeKeys() {
  const records = new Map();
  const db = { collection: name => {
    assert.equal(name, 'apiKeys');
    return { doc: id => ({
      get: async () => ({ exists: records.has(id), data: () => records.get(id) }),
    }) };
  } };
  const issue = (userId, scopes = [MCP_SCOPE]) => {
    const key = generateApiKey();
    records.set(key.id, { id: key.id, hash: key.hash, userId, scopes,
      expiresAt: Date.now() + 60_000 });
    return key;
  };
  return { db, records, issue };
}

async function start(resolveIdentity) {
  const app = express();
  app.use(express.json());
  const auth = createClientAuth(resolveIdentity);
  app.post('/workflows/execute', auth, (req, res) => res.json({
    userId: req.userId, method: req.authMethod, keyId: req.apiKeyId ?? null,
    scopes: req.apiKeyScopes ?? null, body: req.body,
    suppliedHeader: req.headers['x-user-id'] ?? null,
  }));
  app.get('/mcp/auth-check', ...privateMcpMiddleware({
    isOwner: async userId => userId === 'owner',
  }, requireMcpCredential(MCP_RESOURCES.terminal, resolveIdentity), MCP_RESOURCES.terminal),
  (req, res) => res.json({ userId: req.userId, method: req.authMethod, keyId: req.apiKeyId ?? null }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)) };
}

test('existing MCP keys authenticate both API and MCP; revoke and expiry are immediate', async () => {
  const { db, records, issue } = fakeKeys();
  const key = issue('owner'); // a previously issued MCP-only key
  let firebaseCalls = 0;
  const resolver = token => resolveAwflIdentity(token, {
    verifyApiKey: value => verifyAwflApiKey(value, { db }),
    verifyFirebaseToken: async () => { firebaseCalls++; throw new Error('invalid Firebase token'); },
  });
  const app = await start(resolver);
  try {
    const headers = { authorization: `Bearer ${key.token}`,
      'content-type': 'application/json', 'x-user-id': 'forged-user' };
    const response = await fetch(app.url + '/workflows/execute', {
      method: 'POST', headers,
      body: JSON.stringify({ toolNames: [], userId: 'attacker' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { userId: 'owner', method: 'api_key',
      keyId: key.id, scopes: [MCP_SCOPE], body: { toolNames: [] }, suppliedHeader: null });
    const mcp = await fetch(app.url + '/mcp/auth-check', { headers });
    assert.equal(mcp.status, 200);
    assert.deepEqual(await mcp.json(), { userId: 'owner', method: 'api_key', keyId: key.id });
    assert.equal(firebaseCalls, 0, 'API keys must never go to the Firebase verifier');

    records.set(key.id, { ...records.get(key.id), expiresAt: 1 });
    assert.equal((await fetch(app.url + '/workflows/execute', {
      method: 'POST', headers, body: '{}',
    })).status, 403);
    records.set(key.id, { ...records.get(key.id), expiresAt: Date.now() + 60_000 });
    records.delete(key.id);
    assert.equal((await fetch(app.url + '/workflows/execute', {
      method: 'POST', headers, body: '{}',
    })).status, 403);
    assert.equal((await fetch(app.url + '/mcp/auth-check', { headers })).status, 401);
    assert.equal(firebaseCalls, 0);
  } finally {
    await app.close();
  }
});

test('new AWFL access keys and Firebase identities retain owner restrictions', async () => {
  const { db, issue } = fakeKeys();
  const key = issue('other', [API_SCOPE, MCP_SCOPE]);
  const resolver = token => resolveAwflIdentity(token, {
    verifyApiKey: value => verifyAwflApiKey(value, { db }),
    verifyFirebaseToken: async value => {
      if (value !== 'firebase-user') throw new Error('bad token');
      return { uid: 'owner' };
    },
  });
  const app = await start(resolver);
  try {
    const keyHeaders = { authorization: 'Bearer ' + key.token };
    const api = await fetch(app.url + '/workflows/execute', {
      method: 'POST', headers: { ...keyHeaders, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(api.status, 200);
    assert.equal((await api.json()).userId, 'other');
    const mcp = await fetch(app.url + '/mcp/auth-check', { headers: keyHeaders });
    assert.equal(mcp.status, 403, 'MCP owner policy must still apply to API keys');
    const firebase = await fetch(app.url + '/workflows/execute', {
      method: 'POST', headers: { authorization: 'Bearer firebase-user' },
    });
    assert.equal(firebase.status, 200);
    assert.equal((await firebase.json()).method, 'firebase');
    assert.equal((await fetch(app.url + '/mcp/auth-check', {
      headers: { authorization: 'Bearer awfl_v1_malformed' },
    })).status, 401);
  } finally {
    await app.close();
  }
});

test('Firestore verification outage fails closed at both entrypoints', async () => {
  const key = generateApiKey();
  const resolver = token => resolveAwflIdentity(token, {
    verifyApiKey: async () => { throw new Error('Firestore unavailable'); },
  });
  const app = await start(resolver);
  try {
    const headers = { authorization: 'Bearer ' + key.token };
    const api = await fetch(app.url + '/workflows/execute', {
      method: 'POST', headers, body: '{}',
    });
    assert.equal(api.status, 503);
    assert.equal((await fetch(app.url + '/mcp/auth-check', { headers })).status, 503);
  } finally { await app.close(); }
});
