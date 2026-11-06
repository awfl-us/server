import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createMcpRouter } from '../index.js';
import { ExecutionService } from '../service.js';
import { workspaceJob } from '../gke.js';
import { generateApiKey, isActiveApiKeyRecord } from '../../workflows/apiKeys/core.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

test('real SDK client initializes, discovers schemas, invokes tools; rejects auth and other users', async () => {
  const app = express(); app.use(express.json());
  const service = { ownerId: 'owner', invoke: async (user, name, args) => ({ user, name, args }) };
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

test('GKE workload has no cloud/Kubernetes credentials and bounded lifetime/resources', () => {
  const job = workspaceJob({ id: 'a'.repeat(32), token: 'workspace-capability', origin: 'https://api.awfl.us', expiresAt: Date.now() + 3600000, image: 'image' });
  const pod = job.spec.template.spec;
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.containers[0].securityContext.allowPrivilegeEscalation, false);
  assert.equal(pod.containers[0].securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(pod.containers[0].command, ['awfl', 'run']);
  assert.ok(job.spec.activeDeadlineSeconds <= 3600);
  assert.equal(pod.containers[0].env.some(e => /FIREBASE|API_KEY|GOOGLE_APPLICATION/.test(e.name)), false);
});
