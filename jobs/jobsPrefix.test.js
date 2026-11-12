import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

async function unusedPort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('Jobs preserves canonical and /jobs-prefixed routes for unchanged Scala HTTP helpers', async () => {
  const port = await unusedPort();
  const server = spawn(process.execPath, ['jobs.server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), AWFL_NATIVE_EXECUTION_ENABLED: '0' },
    stdio: 'ignore',
  });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        const health = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(500),
        });
        if (health.ok) { ready = true; break; }
      } catch { /* process may still be starting */ }
      if (server.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'Jobs did not start');
    for (const prefix of ['', '/jobs']) {
      const response = await fetch(`http://127.0.0.1:${port}${prefix}/native/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': 'test-user',
          'x-project-id': 'test-project' },
        body: JSON.stringify({ executionId: 'native_' + 'a'.repeat(32) }),
      });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: 'Not Found' },
        `unmounted Jobs route at ${prefix || '/'}`);
    }
  } finally {
    server.kill('SIGTERM');
  }
});
