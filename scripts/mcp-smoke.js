// Real deployed acceptance test. Temporary keys are hashed in Firestore, never logged,
// expire after 15 minutes, and are deleted in finally. No saved user key is read.
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { generateApiKey } from '../workflows/apiKeys/core.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
initializeApp();
const db = getFirestore();
const url = new URL(process.env.MCP_URL || 'https://api.awfl.us/mcp');
const owner = process.env.MCP_OWNER_UID;
const keys = [], report = [];
let workspace, client;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function passed(name, details = {}) { report.push({ name, passed: true, ...details }); console.log('PASS:', name, JSON.stringify(details)); }
async function key(userId = owner, expiresAt = Date.now() + 900000) {
  const k = generateApiKey(); keys.push(k.id);
  await db.collection('apiKeys').doc(k.id).set({ id: k.id, hash: k.hash, userId, scopes: ['mcp:invoke'], expiresAt, name: 'MCP ephemeral deployment test', createdAt: Date.now() });
  return k;
}
async function httpStatus(token) { return (await fetch(url, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} })).status; }
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) throw new Error(`${name}: ${response.content?.[0]?.text}`);
  let result = JSON.parse(response.content[0].text);
  if (name !== 'request_result' && result.state === 'pending' && result.request_id) {
    for (let i = 0; i < 60; i++) {
      await pause(2000);
      result = await call('request_result', { workspace_id: result.workspace_id || args.workspace_id, request_id: result.request_id });
      if (result.state !== 'pending') break;
    }
  }
  if (result.error) throw new Error(`${name}: ${result.error}`);
  return result;
}
async function run(command, timeout = 120) {
  let result = await call('run_command', { workspace_id: workspace, command, timeout });
  const id = result.execution_id;
  let chunks = [...result.chunks];
  for (let i = 0; result.state === 'running' || result.has_more; i++) {
    if (i > timeout + 30) throw new Error('Execution polling exceeded deadline');
    await pause(1000);
    result = await call('command_output', { workspace_id: workspace, execution_id: id, cursor: result.next_cursor });
    chunks.push(...result.chunks);
  }
  return { ...result, stdout: chunks.filter(c => c.stream === 'stdout').map(c => c.text).join(''), stderr: chunks.filter(c => c.stream === 'stderr').map(c => c.text).join('') };
}
try {
  assert.ok(owner);
  assert.equal(await httpStatus(), 401); assert.equal(await httpStatus('invalid'), 401);
  const expired = await key(owner, Date.now() - 1000); assert.equal(await httpStatus(expired.token), 401);
  const revoked = await key(); await db.collection('apiKeys').doc(revoked.id).delete(); assert.equal(await httpStatus(revoked.token), 401);
  const other = await key('mcp-unprivileged-smoke-user'); assert.equal(await httpStatus(other.token), 403);
  passed('missing, invalid, expired, revoked and non-owner credentials rejected');
  const credential = await key();
  client = new Client({ name: 'awfl-deployment-smoke', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${credential.token}` } } }));
  assert.equal((await client.listTools()).tools.length, 9); passed('authenticated SDK discovery');
  const health = await call('environment_status'); assert.equal(health.configured, true); passed('control-plane configured');
  workspace = (await call('workspace_create')).workspace_id;
  passed('workspace created', { workspace_id: workspace });
  // GKE Autopilot provisioning can take several minutes. Queue one readiness call,
  // recover its response by ID instead of flooding the consumer with duplicate work.
  const readyResponse = await client.callTool({ name: 'environment_status', arguments: { workspace_id: workspace } });
  let ready = JSON.parse(readyResponse.content[0].text);
  if (ready.state === 'pending') {
    const requestId = ready.request_id;
    for (let i = 0; i < 100; i++) {
      await pause(5000);
      ready = await call('request_result', { workspace_id: workspace, request_id: requestId });
      if (ready.state === 'ready') break;
    }
  }
  assert.equal(ready.state, 'ready'); passed('Python AWFL consumer connected');
  let result = await run('pwd; uname -a; printf stdout; printf stderr >&2; exit 7');
  assert.equal(result.exit_code, 7); assert.match(result.stdout, /\/workspace/); assert.match(result.stderr, /stderr/);
  passed('isolated commands, stdout, stderr, exit code', { stdout: result.stdout, stderr: result.stderr });
  await call('write_file', { workspace_id: workspace, path: 'reuse.txt', content: 'persistent workspace' });
  assert.equal((await call('workspace_create')).workspace_id, workspace);
  result = await run('cat reuse.txt'); assert.equal(result.stdout, 'persistent workspace'); passed('persistent workspace reuse');
  result = await run('curl -I --max-time 30 https://example.com'); assert.equal(result.exit_code, 0); passed('public HTTPS', { headers: result.stdout.slice(0, 500) });
  result = await run(`python - <<'PY'
import json
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
    page = browser.new_page()
    response = page.goto('https://app.tintwiz.com/login', wait_until='domcontentloaded', timeout=60000)
    page.wait_for_timeout(3000)
    assert response.status < 400, response.status
    title = page.title()
    assert title
    snapshot = page.evaluate("""() => { const root = document.body.cloneNode(true); root.querySelectorAll('script,style,iframe,input,textarea').forEach(x=>x.remove()); root.querySelectorAll('*').forEach(e=>Array.from(e.attributes).forEach(a=>e.removeAttribute(a.name))); return root.outerHTML.slice(0,3000); }""")
    print(json.dumps({'status': response.status, 'title': title, 'sanitized_html': snapshot}))
    browser.close()
PY`, 100);
  assert.equal(result.exit_code, 0, result.stderr); passed('Chromium navigated to TintWiz', JSON.parse(result.stdout));
  const long = await call('run_command', { workspace_id: workspace, command: 'for i in 1 2 3 4 5; do echo tick-$i; sleep 2; done; sleep 60', timeout: 120 });
  assert.equal(long.state, 'running'); await pause(3000);
  const incremental = await call('command_output', { workspace_id: workspace, execution_id: long.execution_id, cursor: long.next_cursor });
  assert.ok(incremental.chunks.length); passed('incremental output', { chunks: incremental.chunks });
  const cancelled = await call('command_cancel', { workspace_id: workspace, execution_id: long.execution_id });
  assert.equal(cancelled.reason, 'cancelled'); assert.equal(cancelled.state, 'completed'); passed('command cancellation');
  const metadata = await run('curl --max-time 3 -s http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token -H "Metadata-Flavor: Google"');
  assert.notEqual(metadata.exit_code, 0); passed('metadata endpoint inaccessible');
  await call('workspace_stop', { workspace_id: workspace, confirm: true }); workspace = null; passed('workspace stopped');
} catch (error) {
  console.error('FAIL:', error.message); report.push({ passed: false, error: error.message }); process.exitCode = 1;
} finally {
  if (workspace && client) await call('workspace_stop', { workspace_id: workspace, confirm: true }).catch(() => {});
  if (client) await client.close();
  await Promise.all(keys.map(id => db.collection('apiKeys').doc(id).delete()));
  writeFileSync('mcp-smoke-results.json', JSON.stringify({ tested_at: new Date().toISOString(), endpoint: url.href, report }, null, 2));
}
