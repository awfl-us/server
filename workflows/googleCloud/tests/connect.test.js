import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  beginGoogleCloudOAuth, disconnectGoogleCloud, finishGoogleCloudOAuth,
  googleCloudConfigured, googleCloudStatus, resolveGoogleCloudAccessToken, testGoogleCloud,
} from '../service.js';
import { consumerCredentialPayload } from '../consumerRefresh.js';

test('consumer refresh broker transmits the real TTL, including for cached tokens', () => {
  assert.deepEqual(consumerCredentialPayload(
    { accessToken: 'token', cloudProjectId: 'awfl-us', expiresIn: 1267 },
    { token: 'github-token', expiresIn: 420 }),
  { accessToken: 'token', cloudProjectId: 'awfl-us', expiresIn: 1267,
    githubToken: 'github-token', githubExpiresIn: 420 });
  assert.deepEqual(consumerCredentialPayload(null, { token: 'git-only' }),
    { githubToken: 'git-only' });
  assert.deepEqual(consumerCredentialPayload(null, { token: 'git-only', expiresIn: 420 }),
    { githubToken: 'git-only', githubExpiresIn: 420 });
});

function firestore() {
  const store = new Map([['users/testuser/projects/project1', { id: 'project1' }]]);
  const ref = path => ({
    collection: name => ({ doc: id => ref(path + '/' + name + '/' + id) }),
    get: async () => { const value = store.get(path); return { exists: store.has(path), data: () => value }; },
    create: async data => { assert.equal(store.has(path), false); store.set(path, data); },
    set: async data => { store.set(path, data); },
    delete: async () => { store.delete(path); },
  });
  return {
    store,
    db: {
      collection: name => ({ doc: id => ref(name + '/' + id) }),
      runTransaction: fn => fn({ get: doc => doc.get(), delete: doc => doc.delete() }),
    },
  };
}
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

test('OAuth uses single-use project-bound state, PKCE, encrypted offline refresh token and no exposed secrets', async () => {
  const names = ['GOOGLE_CLOUD_OAUTH_CLIENT_ID', 'GOOGLE_CLOUD_OAUTH_CLIENT_SECRET', 'ENCRYPTION_SECRET_KEY'];
  const previous = Object.fromEntries(names.map(n => [n, process.env[n]]));
  Object.assign(process.env, { GOOGLE_CLOUD_OAUTH_CLIENT_ID: 'client-test',
    GOOGLE_CLOUD_OAUTH_CLIENT_SECRET: 'secret-test', ENCRYPTION_SECRET_KEY: 'long-test-encryption-key' });
  try {
    assert.equal(googleCloudConfigured(), true);
    const { db, store } = firestore();
    const started = await beginGoogleCloudOAuth({
      userId: 'testuser', projectId: 'project1', cloudProjectId: 'topaigents', db,
    });
    const u = new URL(started.url);
    assert.equal(u.hostname, 'accounts.google.com');
    assert.equal(u.searchParams.get('access_type'), 'offline');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(u.searchParams.get('scope').includes('cloud-platform'));
    const state = u.searchParams.get('state');
    const requests = [];
    const fetcher = async (url, opts) => {
      requests.push({ url, opts });
      if (url.endsWith('/token')) {
        const body = new URLSearchParams(opts.body);
        if (body.get('grant_type') === 'authorization_code') {
          assert.ok(body.get('code_verifier'));
          return response({ access_token: 'access-one', refresh_token: 'refresh-sensitive',
            scope: 'openid email https://www.googleapis.com/auth/cloud-platform', expires_in: 3600 });
        }
        assert.equal(body.get('refresh_token'), 'refresh-sensitive');
        return response({ access_token: 'access-two', expires_in: 3600 });
      }
      if (url.includes('/userinfo')) return response({ email: 'example@example.com' });
      if (url.endsWith('/revoke')) return response({});
      if (url.includes('secretmanager.googleapis.com')) return response({});
      throw new Error('Unexpected URL ' + url);
    };
    const complete = await finishGoogleCloudOAuth({ state, code: 'authorization-code', db, fetcher });
    assert.deepEqual(complete, { projectId: 'project1', result: 'connected' });
    await assert.rejects(finishGoogleCloudOAuth({ state, code: 'authorization-code', db, fetcher }), /Authorization/);
    const status = await googleCloudStatus({ userId: 'testuser', projectId: 'project1', db });
    assert.deepEqual({ connected: status.connected, cloudProjectId: status.cloudProjectId, email: status.email },
      { connected: true, cloudProjectId: 'topaigents', email: 'example@example.com' });
    assert.equal(JSON.stringify([...store.values()]).includes('refresh-sensitive'), false);
    assert.equal(JSON.stringify([...store.values()]).includes('access-one'), false);
    const cred = await resolveGoogleCloudAccessToken({ userId: 'testuser', projectId: 'project1', db, fetcher });
    assert.equal(cred.accessToken, 'access-two');
    assert.equal(cred.cloudProjectId, 'topaigents');
    assert.ok(cred.expiresIn > 3500 && cred.expiresIn <= 3600, 'fresh token gets its real TTL');
    // Simulate a consumer fetching the same cached token 20 minutes later.
    // Its reported TTL MUST have dropped to approximately 40 minutes.
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 20 * 60 * 1000;
      const cached = await resolveGoogleCloudAccessToken({ userId: 'testuser', projectId: 'project1', db, fetcher });
      assert.equal(cached.accessToken, 'access-two');
      assert.ok(cached.expiresIn >= 2398 && cached.expiresIn <= 2400,
        'cached token must report remaining TTL, not original TTL');
    } finally {
      Date.now = realNow;
    }
    const testResult = await testGoogleCloud({ userId: 'testuser', projectId: 'project1', db, fetcher });
    assert.deepEqual(testResult, { cloudProjectId: 'topaigents', access: 'ok' });
    await disconnectGoogleCloud({ userId: 'testuser', projectId: 'project1', db, fetcher });
    assert.equal((await googleCloudStatus({ userId: 'testuser', projectId: 'project1', db })).connected, false);
    assert.equal(await resolveGoogleCloudAccessToken({ userId: 'testuser', projectId: 'project1', db, fetcher }), null);
    assert.equal(requests.some(q => q.url.includes('secretmanager.googleapis.com')), true);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('OAuth rejects unauthorized projects and malformed Google Cloud project IDs', async () => {
  const { db } = firestore();
  const old = process.env.GOOGLE_CLOUD_OAUTH_CLIENT_ID;
  const oldSecret = process.env.GOOGLE_CLOUD_OAUTH_CLIENT_SECRET;
  const oldEncrypt = process.env.ENCRYPTION_SECRET_KEY;
  process.env.GOOGLE_CLOUD_OAUTH_CLIENT_ID = 'client-test';
  process.env.GOOGLE_CLOUD_OAUTH_CLIENT_SECRET = 'secret-test';
  process.env.ENCRYPTION_SECRET_KEY = 'long-test-encryption-key';
  try {
    await assert.rejects(beginGoogleCloudOAuth({
      userId: 'testuser', projectId: 'wrong', cloudProjectId: 'topaigents', db,
    }), /Project not found/);
    await assert.rejects(beginGoogleCloudOAuth({
      userId: 'testuser', projectId: 'project1', cloudProjectId: '../topaigents', db,
    }), /valid Google Cloud project/);
  } finally {
    for (const [n, v] of Object.entries({
      GOOGLE_CLOUD_OAUTH_CLIENT_ID: old,
      GOOGLE_CLOUD_OAUTH_CLIENT_SECRET: oldSecret,
      ENCRYPTION_SECRET_KEY: oldEncrypt,
    })) if (v === undefined) delete process.env[n]; else process.env[n] = v;
  }
});
