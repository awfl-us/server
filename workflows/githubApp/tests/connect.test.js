import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { appJwt, githubAppConfigured, parseGithubRemote } from '../core.js';
import { beginGithubAppOAuth, finishGithubAppOAuth, getGithubAppStatus,
  disconnectGithubApp, resolveGithubAppCredential } from '../service.js';

function fakeFirestore(remote = 'github.com/awfl-us/server.git') {
  const store = new Map();
  const ref = path => ({
    id: path.split('/').at(-1),
    collection: name => ({ doc: id => ref(path + '/' + name + '/' + id) }),
    get: async () => { const snapshot = store.get(path); return { exists: snapshot !== undefined, data: () => snapshot } },
    set: async data => { store.set(path, data) },
    create: async data => {
      if (store.has(path)) throw new Error('Already exists');
      store.set(path, data);
    },
    delete: async () => { store.delete(path) },
  });
  const db = {
    collection: name => ({ doc: id => ref(name + '/' + id) }),
    runTransaction: fn => fn({ get: doc => doc.get(), delete: doc => doc.delete() }),
  };
  store.set('users/owner/projects/project1', { remote, id: 'project1' });
  return { db, store };
}
function response(data) { return { ok: true, json: async () => data }; }

test('parses normalized GitHub remotes and rejects other hosts', () => {
  const expected = { owner: 'awfl-us', repo: 'server', fullName: 'awfl-us/server' };
  for (const remote of ['https://github.com/awfl-us/server.git',
    'github.com/awfl-us/server.git', 'git@github.com:awfl-us/server.git',
    'github.com:awfl-us/server.git', 'ssh://git@github.com/awfl-us/server.git']) {
    assert.deepEqual(parseGithubRemote(remote), expected, remote);
  }
  for (const remote of ['https://github.com.evil.example/awfl-us/server',
    'https://github.com/awfl-us/server/issues', 'https://github.com/awfl-us/server?x=1',
    'https://evil.example/awfl-us/server', '', 'http://github.com/../server']) {
    assert.equal(parseGithubRemote(remote), null, remote);
  }
});

test('JWT uses a signed RS256 app identity with a short lifetime', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const token = appJwt({
    appId: '123',
    privateKeyB64: Buffer.from(privateKey.export({ format: 'pem', type: 'pkcs8' })).toString('base64'),
    nowSeconds: 2000000000,
  });
  const [header, payload, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(claims.iss, '123');
  assert.equal(claims.exp - claims.iat, 600);
  assert.equal(verify('RSA-SHA256', Buffer.from(header + '.' + payload), publicKey, Buffer.from(signature, 'base64url')), true);
});

test('OAuth state binds a verified installation to the owned project without persisting user tokens', async () => {
  const envKeys = ['GITHUB_APP_ID', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET',
    'GITHUB_APP_PRIVATE_KEY_B64', 'GITHUB_APP_SLUG'];
  const old = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  Object.assign(process.env, {
    GITHUB_APP_ID: '123', GITHUB_APP_CLIENT_ID: 'client-test',
    GITHUB_APP_CLIENT_SECRET: 'test-client-secret',
    GITHUB_APP_PRIVATE_KEY_B64: Buffer.from(privateKey.export({ format: 'pem', type: 'pkcs8' })).toString('base64'),
    GITHUB_APP_SLUG: 'awfl-test',
  });
  const { db, store } = fakeFirestore();
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, method: options.method });
    if (url.endsWith('/login/oauth/access_token')) return response({ access_token: 'test-user-token' });
    if (url.includes('/user/installations?')) return response({ installations: [
      { app_id: 123, id: 51, account: { login: 'awfl-us' } },
    ] });
    if (url.includes('/user/installations/51/repositories')) return response({ repositories: [
      { id: 456, full_name: 'awfl-us/server', name: 'server',
        owner: { login: 'awfl-us' }, default_branch: 'main', permissions: { push: true } },
    ] });
    if (url.endsWith('/app/installations/51/access_tokens')) {
      // GitHub grants exactly the installation's current repository selection.
      assert.equal(options.body, undefined);
      return response({ token: 'test-installation-token', expires_at: new Date(Date.now() + 3600000).toISOString() });
    }
    throw new Error('Unexpected request: ' + url);
  };
  try {
    assert.equal(githubAppConfigured(), true);
    const started = await beginGithubAppOAuth({ userId: 'owner', projectId: 'project1', db });
    const url = new URL(started.url);
    assert.equal(url.hostname, 'github.com');
    assert.equal(url.searchParams.get('client_id'), 'client-test');
    const state = url.searchParams.get('state');
    const done = await finishGithubAppOAuth({ state, code: 'testcode', db, fetcher });
    assert.deepEqual(done, { projectId: 'project1', result: 'connected' });
    await assert.rejects(finishGithubAppOAuth({ state, code: 'testcode', db, fetcher }), /Authorization/);
    const status = await getGithubAppStatus({ userId: 'owner', projectId: 'project1', db });
    assert.equal(status.connected, true);
    assert.equal(status.repository, 'awfl-us/server');
    const credential = await resolveGithubAppCredential({ userId: 'owner', projectId: 'project1', db, fetcher });
    assert.deepEqual(credential, { token: 'test-installation-token', owner: 'awfl-us', repo: 'server', defaultBranch: 'main' });
    // Independent AWFL projects linked to the same GitHub installation must
    // share its installation-wide token without accidentally narrowing scope.
    store.set('users/owner/projects/project2',
      { remote: 'github.com/awfl-us/compiler-rust.git', id: 'project2' });
    store.set('users/owner/projects/project2/integrations/githubApp', {
      ...store.get('users/owner/projects/project1/integrations/githubApp'),
      repositoryId: 789, repo: 'compiler-rust', repoFullName: 'awfl-us/compiler-rust',
    });
    const second = await resolveGithubAppCredential({ userId: 'owner', projectId: 'project2', db, fetcher });
    assert.deepEqual(second, {
      token: 'test-installation-token', owner: 'awfl-us',
      repo: 'compiler-rust', defaultBranch: 'main',
    });
    assert.equal(calls.filter(c => c.url.endsWith('/app/installations/51/access_tokens')).length, 1);
    assert.equal([...store.values()].some(doc => JSON.stringify(doc).includes('test-user-token')), false);
    assert.equal([...store.values()].some(doc => JSON.stringify(doc).includes('test-installation-token')), false);
    assert.equal(calls.some(c => c.url.endsWith('/app/installations/51/access_tokens')), true);
    await disconnectGithubApp({ userId: 'owner', projectId: 'project1', db });
    assert.equal((await getGithubAppStatus({ userId: 'owner', projectId: 'project1', db })).connected, false);
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('read-only GitHub access cannot link an installation with write capabilities', async () => {
  const old = Object.fromEntries(['GITHUB_APP_ID', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET',
    'GITHUB_APP_PRIVATE_KEY_B64', 'GITHUB_APP_SLUG'].map(k => [k, process.env[k]]));
  Object.assign(process.env, { GITHUB_APP_ID: '123', GITHUB_APP_CLIENT_ID: 'client',
    GITHUB_APP_CLIENT_SECRET: 'test', GITHUB_APP_PRIVATE_KEY_B64: 'test', GITHUB_APP_SLUG: 'awfl-test' });
  try {
    const { db } = fakeFirestore();
    const start = await beginGithubAppOAuth({ userId: 'owner', projectId: 'project1', db });
    const state = new URL(start.url).searchParams.get('state');
    const fetcher = async url => {
      if (url.endsWith('/login/oauth/access_token')) return response({ access_token: 'user-test' });
      if (url.includes('/user/installations?')) return response({ installations: [
        { app_id: 123, id: 51, account: { login: 'awfl-us' } },
      ] });
      if (url.includes('/user/installations/51/repositories')) return response({ repositories: [
        { id: 456, full_name: 'awfl-us/server', name: 'server', owner: { login: 'awfl-us' },
          permissions: { pull: true, push: false, admin: false } },
      ] });
      throw new Error('Unexpected API path');
    };
    const result = await finishGithubAppOAuth({ state, code: 'testcode', db, fetcher });
    assert.equal(result.result, 'install_required');
    assert.equal((await getGithubAppStatus({ userId: 'owner', projectId: 'project1', db })).connected, false);
  } finally {
    for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : process.env[k] = v;
  }
});
