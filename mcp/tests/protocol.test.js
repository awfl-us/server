import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createMcpRouter } from '../index.js';
import { ExecutionService } from '../service.js';
import { generateApiKey, isActiveApiKeyRecord } from '../../workflows/apiKeys/core.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function memoryDb() {
  const data = new Map();
  const watchers = new Map();
  function doc(path) {
    return {
      path,
      async get() {
        const value = data.get(path);
        return { exists: value !== undefined, data: () => value };
      },
      async set(payload, opts) {
        data.set(path, opts?.merge ? { ...data.get(path), ...payload } : { ...payload });
        for (const callback of watchers.get(path) || []) callback(await this.get());
      },
      async update(payload) {
        if (!data.has(path)) throw new Error('No document at ' + path);
        return this.set(payload, { merge: true });
      },
      collection(name) { return collection(path + '/' + name); },
      onSnapshot(callback) {
        let active = true;
        const listener = snap => { if (active) callback(snap); };
        const callbacks = watchers.get(path) || [];
        callbacks.push(listener); watchers.set(path, callbacks);
        void this.get().then(listener);
        return () => { active = false; };
      },
    };
  }
  function collection(path) {
    return { doc(id) { return doc(path + '/' + id); } };
  }
  return {
    data, collection,
    async runTransaction(fn) {
      return fn({
        get: d => d.get(),
        set: (d, payload, opts) => d.set(payload, opts),
        create: (d, payload) => d.set(payload),
        update: (d, payload) => d.update(payload),
      });
    },
  };
}

test('MCP SDK exposes nine tools and enforces owner auth', async () => {
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
  const url = new URL('http://127.0.0.1:' + server.address().port + '/mcp');
  const client = new Client({ name: 'test', version: '1' });
  try {
    for (const [authorization, status] of [['', 401], ['Bearer invalid', 401], ['Bearer other', 403]]) {
      assert.equal((await fetch(url, { method: 'POST', headers: { authorization } })).status, status);
    }
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer valid' } } }));
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 9);
    assert.equal(listed.tools.find(t => t.name === 'run_command').annotations.destructiveHint, true);
    assert.equal(listed.tools.find(t => t.name === 'workspace_create').inputSchema.required.includes('project_id'), true);
    const result = await client.callTool({ name: 'environment_status', arguments: {} });
    assert.equal(JSON.parse(result.content[0].text).user, 'owner');
    const invalid = await client.callTool({ name: 'workspace_create', arguments: {} });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('API keys reject expired, missing scope and deleted records', () => {
  const key = generateApiKey();
  const record = { ...key, userId: 'owner', scopes: ['mcp:invoke'], expiresAt: Date.now() + 10000 };
  assert.equal(isActiveApiKeyRecord(key.token, record), true);
  assert.equal(isActiveApiKeyRecord(key.token, { ...record, expiresAt: 1 }), false);
  assert.equal(isActiveApiKeyRecord(key.token, { ...record, scopes: [] }), false);
  assert.equal(isActiveApiKeyRecord(key.token, null), false);
});

test('MCP attaches to existing project consumer without starting an independent Job or changing lock', async () => {
  const db = memoryDb();
  const userId = 'owner', projectId = 'repo-1';
  await db.collection('users').doc(userId).collection('projects').doc(projectId).set({ name: 'TopAigents' });
  const launches = [];
  const service = new ExecutionService({
    db, ownerId: userId,
    startConsumer: async ctx => { launches.push(ctx); return { state: 'attached', consumerId: 'existing-consumer' }; },
    getLock: async () => ({ lock: { consumerId: 'existing-consumer', expiresAt: Date.now() + 40000 } }),
    backend: () => ({ append: async () => {} }),
  });
  const first = await service.invoke(userId, 'workspace_create', { project_id: projectId, session_id: 'existing-conversation' });
  const second = await service.invoke(userId, 'workspace_create', { project_id: projectId, session_id: 'second-conversation' });
  assert.equal(first.state, 'attached');
  assert.equal(second.state, 'attached');
  assert.equal(first.project_id, projectId);
  assert.equal(first.session_id, 'existing-conversation');
  assert.equal(first.consumer_id, 'existing-consumer');
  assert.equal(launches.length, 2);
  assert.deepEqual(launches, [{ userId, projectId }, { userId, projectId }]);
  // Detach one session without deleting the other session or the project consumer.
  assert.deepEqual(await service.invoke(userId, 'workspace_stop', { workspace_id: first.workspace_id, confirm: true }),
    { workspace_id: first.workspace_id, state: 'detached', consumer_stopped: false });
  const ws2 = await service.owned(userId, second.workspace_id);
  assert.equal(ws2.sessionId, 'second-conversation');
  await assert.rejects(service.owned(userId, first.workspace_id), /Workspace stopped/);
});

test('MCP writes normal project/session events, atomically claims once and correlates result', async () => {
  const db = memoryDb();
  const userId = 'owner', projectId = 'repo-1';
  const events = [];
  await db.collection('users').doc(userId).collection('projects').doc(projectId).set({ name: 'TopAigents' });
  let service;
  service = new ExecutionService({
    db, ownerId: userId,
    startConsumer: async () => ({ state: 'attached', consumerId: 'existing-consumer' }),
    getLock: async () => ({ lock: { consumerId: 'existing-consumer', expiresAt: Date.now() + 40000 } }),
    backend: () => ({ append: async event => {
      events.push(event);
      if (event.type === 'mcp_tool_call') {
        const { workspace_id, request_id } = event.data.mcp;
        assert.deepEqual(await service.claim(userId, projectId, workspace_id, request_id), { claimed: true });
        assert.deepEqual(await service.claim(userId, projectId, workspace_id, request_id), { claimed: false });
        assert.deepEqual(await service.complete(userId, projectId, workspace_id, request_id,
          { execution_id: '123abc', state: 'running' }), { ok: true });
      }
    } }),
  });
  const ws = await service.invoke(userId, 'workspace_create', { project_id: projectId, session_id: 'session-A' });
  const response = await service.invoke(userId, 'run_command', { workspace_id: ws.workspace_id, command: 'echo hello' });
  assert.deepEqual(response, { execution_id: '123abc', state: 'running' });
  assert.equal(events.length, 2);
  assert.equal(events[0].projectId, projectId);
  assert.equal(events[0].sessionId, 'session-A');
  assert.equal(events[0].type, 'mcp_tool_call');
  assert.equal(events[0].data.tool_call.function.arguments.command, 'echo hello');
  assert.equal(events[1].type, 'mcp_tool_result');
  assert.equal(events[1].sessionId, 'session-A');
  assert.equal(events[1].data.content, 'MCP run_command completed');
  await assert.rejects(service.invoke('other', 'workspace_stop', { workspace_id: ws.workspace_id, confirm: true }), /Owner access required/);
});

test('workspace ownership rejects other accounts before inspecting project resources', async () => {
  const db = memoryDb();
  await db.collection('mcpWorkspaces').doc('a'.repeat(32)).set({
    userId: 'other', projectId: 'private', expiresAt: Date.now() + 10000, stopped: false,
  });
  const service = new ExecutionService({ db, ownerId: 'owner' });
  await assert.rejects(service.invoke('owner', 'workspace_stop', { workspace_id: 'a'.repeat(32), confirm: true }), /Workspace not found/);
});

test('without configured owner only sole active MCP key owner can invoke', async () => {
  const docs = [{ data: () => ({ userId: 'owner', expiresAt: Date.now() + 100000, scopes: ['mcp:invoke'] }) }];
  const db = { collection: () => ({ get: async () => ({ docs }) }) };
  const service = new ExecutionService({ db, ownerId: '' });
  assert.equal(await service.isOwner('owner'), true);
  assert.equal(await service.isOwner('another'), false);
  docs.push({ data: () => ({ userId: 'another', expiresAt: Date.now() + 100000, scopes: ['mcp:invoke'] }) });
  assert.equal(await service.isOwner('owner'), false);
});

test('workspace health checks the existing consumer Job rather than trusting a lease alone', async () => {
  const service = new ExecutionService({
    db: {}, ownerId: 'owner',
    getLock: async () => ({ lock: {
      consumerId: 'consumer-shared', expiresAt: Date.now() + 60000,
      runtime: { mode: 'gke', namespace: 'awfl', consumerJobName: 'consumer-shared' },
    } }),
    inspectJob: async ({namespace,jobName}) => {
      assert.equal(namespace, 'awfl'); assert.equal(jobName, 'consumer-shared');
      return { state: 'failed', failed: 1, active: 0, succeeded: 0 };
    },
  });
  const status = await service.status('owner', { projectId: 'project-1', sessionId: 'session-1' });
  assert.equal(status.consumer_id, 'consumer-shared');
  assert.equal(status.state, 'consumer_unavailable');
  assert.equal(status.consumer_job.failed, 1);
});

test('pending MCP request exposes persisted Firestore lifecycle without leaking command data', async () => {
  const db = memoryDb();
  const id = 'a'.repeat(32);
  const requestRef = db.collection('mcpWorkspaces').doc(id).collection('mcpRequests').doc('00000001');
  await db.collection('mcpWorkspaces').doc(id).set({
    userId: 'owner', projectId: 'topaigents', sessionId: 'test-session',
    expiresAt: Date.now() + 60000, stopped: false,
  });
  await requestRef.set({ state: 'queued', createdAt: 1234, toolName: 'run_command',
    args: { command: 'secret-command' } });
  const service = new ExecutionService({ db, ownerId: 'owner' });
  assert.deepEqual(await service.invoke('owner', 'request_result', { workspace_id: id, request_id: 1 }), {
    state: 'pending', request_id: 1, request_state: 'queued',
    created_at: 1234, claimed_at: null,
  });
  await requestRef.update({ state: 'running', claimedAt: 2345 });
  assert.deepEqual(await service.invoke('owner', 'request_result', { workspace_id: id, request_id: 1 }), {
    state: 'pending', request_id: 1, request_state: 'running',
    created_at: 1234, claimed_at: 2345,
  });
});
