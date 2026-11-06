import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createMcpRouter } from '../index.js';
import { ExecutionService } from '../service.js';
import { ExistingConsumerRuntime, mcpConsumerEnv } from '../../jobs/producer/mcpRunner.js';
import { generateApiKey, isActiveApiKeyRecord } from '../../workflows/apiKeys/core.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

test('real SDK client initializes, discovers schemas, invokes tools; rejects auth and other users', async () => {
  const app = express(); app.use(express.json());
  const service = { isOwner: async user => user === 'owner', invoke: async (user, name, args) => ({ user, name, args }) };
  app.use('/mcp', createMcpRouter(service, (req, res, next) => {
    if (req.get('authorization') === 'Bearer valid') req.userId = 'owner';
    else if (req.get('authorization') === 'Bearer other') req.userId = 'other';
    else return res.sendStatus(401);
    next();
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const client = new Client({ name: 'test', version: '1' });
  try {
    for (const [authorization, status] of [['', 401], ['Bearer invalid', 401], ['Bearer other', 403]]) {
      assert.equal((await fetch(url, { method: 'POST', headers: { authorization } })).status, status);
    }
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer valid' } } }));
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 9);
    assert.equal(listed.tools.find(t => t.name === 'run_command').annotations.destructiveHint, true);
    const result = await client.callTool({ name: 'environment_status', arguments: {} });
    assert.equal(JSON.parse(result.content[0].text).user, 'owner');
    const invalid = await client.callTool({ name: 'run_command', arguments: { workspace_id: '../../other', command: 'true' } });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); await new Promise(resolve => server.close(resolve)); }
});

test('workspace ownership is checked before returning state or stopping resources', async () => {
  const db = { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ userId: 'other', expiresAt: Date.now() + 10000 }) }) }) }) };
  const service = new ExecutionService({ db, runtime: {}, ownerId: 'owner' });
  await assert.rejects(service.invoke('owner', 'workspace_stop', { workspace_id: 'a'.repeat(32), confirm: true }), /Workspace not found/);
});

test('API keys reject expired, missing scope and deleted records', () => {
  const key = generateApiKey();
  const record = { ...key, userId: 'owner', scopes: ['mcp:invoke'], expiresAt: Date.now() + 10000 };
  assert.equal(isActiveApiKeyRecord(key.token, record), true);
  assert.equal(isActiveApiKeyRecord(key.token, { ...record, expiresAt: 1 }), false);
  assert.equal(isActiveApiKeyRecord(key.token, { ...record, scopes: [] }), false);
  assert.equal(isActiveApiKeyRecord(key.token, null), false);
});

test('MCP reuses existing AWFL namespace, consumer image, launcher and credentials', async () => {
  const previous = {
    image: process.env.CONSUMER_K8S_IMAGE,
    ns: process.env.K8S_NAMESPACE,
  };
  process.env.CONSUMER_K8S_IMAGE = 'existing-awfl-consumer-image';
  process.env.K8S_NAMESPACE = 'awfl';
  const seen = [];
  const runtime = new ExistingConsumerRuntime({
    credentials: async () => ({
      githubToken: 'test-github-token',
      firebaseIdToken: 'test-firebase-token',
      firebaseCustomToken: 'test-custom-token',
    }),
    launch: async args => { seen.push({ op: 'start', ...args }); return { ok: true }; },
    remove: async args => { seen.push({ op: 'stop', ...args }); return { ok: true }; },
  });
  try {
    const now = Date.now();
    await runtime.start({
      id: 'a'.repeat(32), token: 'mcp-capability', expiresAt: now + 3600000,
      origin: 'https://api.awfl.us', userId: 'owner', projectId: 'project-1',
    });
    const started = seen[0];
    assert.equal(started.namespace, 'awfl');
    assert.equal(started.image, 'existing-awfl-consumer-image');
    assert.equal(started.serviceAccountName, 'consumer');
    assert.deepEqual(started.command, ['awfl', 'run']);
    assert.ok(started.activeDeadlineSeconds > 0 && started.activeDeadlineSeconds <= 3600);
    const env = Object.fromEntries(started.envPairs.map(item => [item.name, item.value]));
    assert.equal(env.AWFL_PROJECT_ID, 'project-1');
    assert.equal(env.GITHUB_TOKEN, 'test-github-token');
    assert.equal(env.FIREBASE_ID_TOKEN, 'test-firebase-token');
    assert.equal(env.FIREBASE_CUSTOM_TOKEN, 'test-custom-token');
    assert.equal(env.AWFL_EXECUTION_URL, 'https://api.awfl.us/mcp-consumer/' + 'a'.repeat(32));
    assert.equal(env.AWFL_EXECUTION_TOKEN, 'mcp-capability');
    await runtime.stop('mcp-' + 'a'.repeat(32));
    assert.deepEqual(seen[1], { op: 'stop', namespace: 'awfl', jobName: 'mcp-' + 'a'.repeat(32), propagationPolicy: 'Foreground' });
  } finally {
    if (previous.image === undefined) delete process.env.CONSUMER_K8S_IMAGE;
    else process.env.CONSUMER_K8S_IMAGE = previous.image;
    if (previous.ns === undefined) delete process.env.K8S_NAMESPACE;
    else process.env.K8S_NAMESPACE = previous.ns;
  }
});

test('unconfigured owner resolves only the sole active key owner', async () => {
  let docs = [{ data: () => ({ userId: 'owner', expiresAt: Date.now() + 100000, scopes: ['mcp:invoke'] }) }];
  const db = { collection: () => ({ get: async () => ({ docs }) }) };
  const service = new ExecutionService({ db, runtime: {}, ownerId: '' });
  assert.equal(await service.isOwner('owner'), true);
  assert.equal(await service.isOwner('another'), false);
  docs = [...docs, { data: () => ({ userId: 'another', expiresAt: Date.now() + 100000, scopes: ['mcp:invoke'] }) }];
  assert.equal(await service.isOwner('owner'), false);
});

test('workspace capabilities are bounded to one workspace and expire immediately', async () => {
  const { digest } = await import('../service.js');
  const token = 'a'.repeat(43);
  let record = { userId: 'owner', capabilityHash: digest(token), expiresAt: Date.now() + 10000, stopped: false };
  const db = { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => record }) }) }) };
  const service = new ExecutionService({ db, runtime: {}, ownerId: 'owner' });
  assert.ok(await service.consumer('a'.repeat(32), token));
  assert.equal(await service.consumer('a'.repeat(32), 'b'.repeat(43)), null);
  record.stopped = true;
  assert.equal(await service.consumer('a'.repeat(32), token), null);
  record.stopped = false; record.expiresAt = Date.now() - 1;
  assert.equal(await service.consumer('a'.repeat(32), token), null);
});
