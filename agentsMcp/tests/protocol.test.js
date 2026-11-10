import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { agentTools } from '../tools.js';
import { createAgentsMcpRouter } from '../index.js';

test('separate AWFL Agents MCP follows the Devin session interface and enforces owner/auth', async () => {
  const calls = [], sessions = [];
  const executionService = {
    isOwner: async id => id === 'owner',
    listProjects: async (userId, args) => ({ userId, args, projects: [{ id: 'repo' }] }),
  };
  const sessionService = {
    listAgents: async userId => ({ agents: [{ id: 'code', workflowName: 'codebase-ProjectManager', userId }] }),
    listSessions: async (_userId, args) => ({ sessions: [], project_id: args.project_id }),
    getSession: async (_userId, args) => ({ ...args, status: 'Running' }),
    listMessages: async (_userId, args) => ({ ...args, messages: [] }),
    reviewSession: async (_userId, args) => ({ ...args, messages: [], status: 'Running' }),
    searchConversations: async (_userId, args) => ({ query: args.query, sessions: [] }),
    searchSessionMatches: async (_userId, args) => ({ query: args.query, messages: [] }),
    createSession: async (userId, args) => {
      calls.push({ name: 'create', userId, args });
      sessions.push(args);
      return { session_id: 's' + sessions.length, status: 'submitted' };
    },
    sendMessage: async (userId, args) => {
      calls.push({ name: 'send', userId, args });
      return { session_id: args.session_id, execution_name: 'exec2' };
    },
    terminateSession: async (userId, args) => {
      calls.push({ name: 'terminate', userId, args });
      return { session_id: args.session_id, results: [{ cancelled: true }] };
    },
  };
  const app = express(); app.use(express.json());
  app.use('/mcp/agents', createAgentsMcpRouter({
    sessionService, executionService,
    authenticate: (req,res,next) => {
      if (req.get('authorization') === 'Bearer owner') req.userId = 'owner';
      else if (req.get('authorization') === 'Bearer guest') req.userId = 'guest';
      else return res.sendStatus(401);
      next();
    },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = new URL('http://127.0.0.1:' + server.address().port + '/mcp/agents');
  const client = new Client({ name: 'agents-mcp-test', version: '1.0' });
  try {
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    assert.equal((await fetch(url, {
      method: 'POST', headers: { authorization: 'Bearer guest' },
    })).status, 403);
    assert.equal((await fetch(url, {
      method: 'POST', headers: { authorization: 'Bearer owner', Origin: 'https://evil.example' },
    })).status, 403);
    await client.connect(new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: 'Bearer owner' } },
    }));
    assert.match(client.getInstructions(), /SAME project-scoped/);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, Object.keys(agentTools).length);
    for (const name of ['list_sessions', 'get_session', 'list_messages', 'review_session',
      'create_session', 'send_message', 'terminate_session', 'search_conversations',
      'search_session_matches', 'launch_batch', 'message_batch']) {
      assert.ok(listed.tools.some(tool => tool.name === name), name);
    }
    assert.equal(listed.tools.find(t => t.name === 'list_messages').annotations.readOnlyHint, true);
    assert.equal(listed.tools.find(t => t.name === 'terminate_session').annotations.destructiveHint, true);
    const launched = await client.callTool({ name: 'create_session', arguments: {
      project_id: 'repo', agent_id: 'code', prompt: 'Check tests', fund: 0.25,
    } });
    assert.equal(JSON.parse(launched.content[0].text).session_id, 's1');
    assert.equal(calls[0].args.model, 'gpt-5');
    assert.equal(calls[0].args.fund, 0.25);
    const followed = await client.callTool({ name: 'send_message', arguments: {
      project_id: 'repo', session_id: 's1', message: 'Now review the diff',
    } });
    assert.equal(JSON.parse(followed.content[0].text).execution_name, 'exec2');
    assert.equal(calls[1].args.session_id, 's1');
    const invalid = await client.callTool({ name: 'terminate_session', arguments: {
      project_id: 'repo', session_id: 's1',
    } });
    assert.equal(invalid.isError, true);
    assert.equal(calls.filter(c => c.name === 'terminate').length, 0);
    const terminated = await client.callTool({ name: 'terminate_session', arguments: {
      project_id: 'repo', session_id: 's1', confirm: true,
    } });
    assert.equal(JSON.parse(terminated.content[0].text).results[0].cancelled, true);
    const batch = await client.callTool({ name: 'message_batch', arguments: {
      project_id: 'repo', session_ids: ['s1','s2'], message: 'Summarize changes',
    } });
    assert.equal(JSON.parse(batch.content[0].text).results.length, 2);
    assert.equal(calls.filter(c => c.name === 'send').length, 3);
  } finally {
    await client.close();
    await new Promise(resolve => server.close(resolve));
  }
});
