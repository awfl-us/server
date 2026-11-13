import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getApps, initializeApp } from 'firebase-admin/app';
if (!getApps().length) initializeApp({ projectId: 'awfl-agents-mcp-test' });
const { AgentSessionService } = await import('../service.js');
const { createWorkflowExecution } = await import('../../workflows/services/executeWorkflow.js');
const { latestSessionExecutions } = await import('../../workflows/exec/statusService.js');

function memoryDb() {
  const data = new Map();
  let nextId = 1;
  function doc(path) {
    return {
      id: path.split('/').at(-1),
      async get() {
        const value = data.get(path);
        return { id: path.split('/').at(-1), exists: value !== undefined,
          data: () => value };
      },
      async set(value, opts) {
        data.set(path, opts?.merge ? { ...(data.get(path) || {}), ...value } : { ...value });
      },
      async delete() { data.delete(path); },
    };
  }
  function collection(path) {
    const options = { order: null, descending: false, offset: 0, limit: Infinity };
    const query = {
      doc(id) { return doc(path + '/' + (id || `auto${nextId++}`)); },
      orderBy(field, direction = 'asc') { options.order = field; options.descending = direction === 'desc'; return this; },
      offset(value) { options.offset = value; return this; },
      limit(value) { options.limit = value; return this; },
      where(field, op, value) { options.filter = { field, op, value }; return this; },
      async get() {
        let docs = [...data].filter(([key]) => key.startsWith(path + '/') &&
          !key.slice(path.length + 1).includes('/'))
          .map(([key, value]) => ({ ...doc(key), data: () => value }));
        if (options.filter) docs = docs.filter(d =>
          d.data()[options.filter.field] === options.filter.value);
        if (options.order) docs.sort((a,b) => {
          const x = a.data()[options.order] ?? 0, y = b.data()[options.order] ?? 0;
          return (x > y ? 1 : x < y ? -1 : a.id.localeCompare(b.id)) *
            (options.descending ? -1 : 1);
        });
        docs = docs.slice(options.offset, options.offset + options.limit);
        return { docs, empty: docs.length === 0 };
      },
    };
    return query;
  }
  return { data, doc, collection };
}

test('new AWFL sessions use the current workflow launcher and existing agent map', async () => {
  const db = memoryDb(), calls = [];
  const user = 'owner', project = 'project-a';
  await db.doc('users/owner/projects/project-a').set({ name: 'repo' });
  await db.doc('users/owner/agents/code-agent').set({
    id: 'code-agent', workflowName: 'codebase-ProjectManager', name: 'Code Agent',
  });
  const service = new AgentSessionService({
    db,
    execute: async args => { calls.push(args); return { executionName: 'executions/first' }; },
    getStatuses: async () => [{ execId: 'first', status: 'Running' }],
  });
  const started = await service.createSession(user, {
    project_id: project, agent_id: 'code-agent', prompt: 'Inspect the repository',
    model: 'gpt-5', fund: 0.5,
  });
  assert.ok(started.session_id);
  assert.equal(started.execution_name, 'executions/first');
  assert.equal(calls[0].workflowName, 'codebase-ProjectManager');
  assert.equal(calls[0].params.query, 'Inspect the repository');
  assert.equal(calls[0].params.sessionId, started.session_id);
  assert.equal(calls[0].params.fund, 0.5);
  const mapping = await db.doc(`users/owner/projects/project-a/agentSessions/${started.session_id}`).get();
  assert.equal(mapping.data().agentId, 'code-agent');
  const continued = await service.sendMessage(user, {
    project_id: project, session_id: started.session_id, message: 'Continue with tests',
  });
  assert.equal(continued.session_id, started.session_id);
  assert.equal(calls[1].params.sessionId, started.session_id);
  assert.equal(calls[1].params.query, 'Continue with tests');
  assert.equal((await service.getSession(user, { project_id: project,
    session_id: started.session_id })).status, 'Running');
  await assert.rejects(service.sendMessage(user, {
    project_id: 'another', session_id: started.session_id, message: 'invalid',
  }), /Project not found/);
});

test('history is project-scoped, chronological, and paginated like Devin', async () => {
  const db = memoryDb(), path = 'users/owner/projects/project-a';
  await db.doc(path).set({});
  await db.doc(path + '/convo.sessions/session-a').set({ update_time: 2, title: 'A' });
  await db.doc(path + '/convo.sessions/session-b').set({ update_time: 1, title: 'B' });
  const messages = path + '/convo.sessions/session-a/messages/';
  await db.doc(messages + 'm1').set({ create_time: 1, value: { role: 'user', content: 'Please run checks' } });
  await db.doc(messages + 'm2').set({ create_time: 2, value: { role: 'assistant', content: 'Running checks now' } });
  await db.doc(messages + 'm3').set({ create_time: 3, value: { role: 'user', content: 'Check logs too' } });
  const service = new AgentSessionService({ db, getStatuses: async () => [] });
  const list = await service.listSessions('owner', { project_id: 'project-a', first: 1 });
  assert.equal(list.sessions[0].id, 'session-a');
  assert.equal(list.has_next_page, true);
  const next = await service.listSessions('owner', { project_id: 'project-a', first: 1, after: list.end_cursor });
  assert.equal(next.sessions[0].id, 'session-b');
  const first = await service.listMessages('owner', {
    project_id: 'project-a', session_id: 'session-a', first: 2,
  });
  assert.deepEqual(first.messages.map(m => m.id), ['m1', 'm2']);
  const more = await service.listMessages('owner', {
    project_id: 'project-a', session_id: 'session-a', first: 2, after: first.end_cursor,
  });
  assert.deepEqual(more.messages.map(m => m.id), ['m3']);
  assert.equal(more.has_next_page, false);
  const review = await service.reviewSession('owner', {
    project_id: 'project-a', session_id: 'session-a', first: 1,
  });
  assert.equal(review.messages[0].content, 'Please run checks');
  const searched = await service.searchConversations('owner', {
    project_id: 'project-a', query: '"run checks" AND logs',
  });
  assert.equal(searched.sessions[0].session_id, 'session-a');
  assert.ok(searched.sessions[0].excerpts.length >= 2);
  const matches = await service.searchSessionMatches('owner', {
    project_id: 'project-a', session_id: 'session-a', query: 'logs', first: 3,
  });
  assert.deepEqual(matches.messages.map(m => m.id), ['m3']);
  await assert.rejects(service.listMessages('owner', {
    project_id: 'project-a', session_id: 'session-a', after: 'invalid',
  }), /cursor/);
});

test('session termination calls existing execution-tree cancellation implementation', async () => {
  const db = memoryDb(), path = 'users/owner/projects/proj';
  await db.doc(path).set({});
  await db.doc(path + '/agentSessions/s1').set({ agentId: 'ag' });
  await db.doc('users/owner/agents/ag').set({ workflowName: 'codebase-ProjectManager', name: 'Code Agent' });
  const calls = [];
  const service = new AgentSessionService({
    db, getStatuses: async () => [{ execId: 'exec-1', status: 'Running' }],
    cancel: async args => { calls.push(args); return { status: 200,
      body: { results: [{ execId: 'exec-1', cancelled: true }] } }; },
  });
  const response = await service.terminateSession('owner', { project_id: 'proj', session_id: 's1' });
  assert.equal(response.results[0].cancelled, true);
  assert.deepEqual(calls, [{ userId: 'owner', projectId: 'proj', execId: 'exec-1',
    workflow: 'codebase-ProjectManager', includeDescendants: true }]);
});

test('web and MCP launcher use the same scoped Google Workflow arguments', async () => {
  const old = { project: process.env.GCP_PROJECT, base: process.env.WORKFLOWS_BASE_URL };
  process.env.GCP_PROJECT = 'awfl-us';
  process.env.WORKFLOWS_BASE_URL = 'https://jobs.example.test';
  const created = [];
  const client = {
    workflowPath: (...args) => args.join('/'),
    createExecution: async arg => { created.push(arg); return [{ name: 'execution-123' }]; },
  };
  try {
    const output = await createWorkflowExecution({
      userId: 'owner', projectId: 'proj', workflowName: 'codebase-ProjectManager',
      params: { query: 'test', model: 'gpt-5', sessionId: 's1',
        env: { userId: 'attacker', projectId: 'wrong' } }, client,
      // This test specifically checks the legacy Google Workflows path.
      // Production native routing may be enabled independently in CI.
      nativeBackend: null,
    });
    assert.equal(output.executionName, 'execution-123');
    const args = JSON.parse(created[0].execution.argument);
    assert.equal(args.env.userId, 'owner');
    assert.equal(args.env.projectId, 'proj');
    assert.equal(args.env.BASE_URL, 'https://jobs.example.test');
    assert.equal(args.sessionId, 's1');
  } finally {
    if (old.project === undefined) delete process.env.GCP_PROJECT;
    else process.env.GCP_PROJECT = old.project;
    if (old.base === undefined) delete process.env.WORKFLOWS_BASE_URL;
    else process.env.WORKFLOWS_BASE_URL = old.base;
  }
});

test('shared execution status lookup preserves the existing no-status HTTP distinction', async () => {
  const db = memoryDb();
  const args = { db, userId: 'owner', projectId: 'proj', sessionId: 's1', includeMetadata: true };
  assert.deepEqual(await latestSessionExecutions(args), { items: [], hasRegistrations: false });
  await db.doc('users/owner/projects/proj/workflowExecsBySession/registration').set({
    sessionId: 's1', execId: 'exec-1', created: 1,
  });
  assert.deepEqual(await latestSessionExecutions(args), { items: [], hasRegistrations: true });
  await db.doc('users/owner/projects/proj/workflowExecStatus/exec-1').set({ status: 'Running' });
  const result = await latestSessionExecutions(args);
  assert.equal(result.items[0].status, 'Running');
  assert.equal(result.items[0].execId, 'exec-1');
});
