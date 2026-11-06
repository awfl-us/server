// Read-only smoke check for the shared AWFL project consumer.
// Requires MCP_OWNER_UID and MCP_PROJECT_ID; never starts a separate MCP Job.
// Only a temporary scoped API key and an MCP session attachment are created.
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import assert from 'node:assert/strict';
import { generateApiKey } from '../workflows/apiKeys/core.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

initializeApp();
const db = getFirestore();
const url = new URL(process.env.MCP_URL || 'https://api.awfl.us/mcp');
const owner = process.env.MCP_OWNER_UID;
const project = process.env.MCP_PROJECT_ID;
const session = process.env.MCP_SESSION_ID || 'mcp-smoke-' + Date.now();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let client, workspace, keyId;

async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) throw new Error(name + ': ' + response.content?.[0]?.text);
  let result = JSON.parse(response.content[0].text);
  if (name !== 'request_result' && result.state === 'pending' && result.request_id) {
    for (let attempt = 0; attempt < 90 && result.state === 'pending'; attempt++) {
      await pause(2000);
      result = await call('request_result', {
        workspace_id: result.workspace_id || args.workspace_id,
        request_id: result.request_id,
      });
    }
  }
  if (result.error) throw new Error(name + ': ' + result.error);
  return result;
}
try {
  assert.ok(owner, 'MCP_OWNER_UID required');
  assert.ok(project, 'MCP_PROJECT_ID required (do not select a random first project)');
  const credential = generateApiKey();
  keyId = credential.id;
  await db.collection('apiKeys').doc(keyId).set({
    id: keyId, hash: credential.hash, userId: owner, scopes: ['mcp:invoke'],
    expiresAt: Date.now() + 900000, name: 'temporary shared-project MCP smoke check',
    createdAt: Date.now(),
  });

  client = new Client({ name: 'awfl-shared-consumer-smoke', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: 'Bearer ' + credential.token } },
  }));
  assert.equal((await client.listTools()).tools.length, 9);
  const health = await call('environment_status');
  assert.equal(health.configured, true);
  const attached = await call('workspace_create', { project_id: project, session_id: session });
  workspace = attached.workspace_id;
  assert.equal(attached.project_id, project);
  assert.equal(attached.session_id, session);
  assert.equal(attached.shared, true);
  const status = await call('environment_status', { workspace_id: workspace });
  assert.equal(status.shared, true);
  assert.equal(status.project_id, project);

  const command = await call('run_command', {
    workspace_id: workspace,
    command: 'printf shared-project-consumer; printf " %s" "$AWFL_PROJECT_ID"',
    timeout: 30,
  });
  let state = command, chunks = [...(state.chunks || [])];
  for (let attempt = 0; attempt < 40 && (state.state === 'running' || state.has_more); attempt++) {
    await pause(500);
    state = await call('command_output', {
      workspace_id: workspace, execution_id: command.execution_id,
      cursor: state.next_cursor,
    });
    chunks.push(...(state.chunks || []));
  }
  assert.equal(state.state, 'completed');
  assert.equal(state.exit_code, 0);
  const stdout = chunks.filter(x => x.stream === 'stdout').map(x => x.text).join('');
  assert.match(stdout, /shared-project-consumer/);
  assert.match(stdout, new RegExp(project));
  console.log('PASS: MCP shared project consumer and session', {
    project_id: project, session_id: session, workspace_id: workspace,
  });
} finally {
  if (workspace && client) {
    await call('workspace_stop', { workspace_id: workspace, confirm: true }).catch(() => {});
  }
  if (client) await client.close().catch(() => {});
  if (keyId) await db.collection('apiKeys').doc(keyId).delete().catch(() => {});
}
