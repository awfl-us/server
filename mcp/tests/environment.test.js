import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeEnvironment, ENVIRONMENT_GUIDE, ENVIRONMENT_INSTRUCTIONS } from '../environment.js';
import { ExecutionService } from '../service.js';

const candidate = {
  cwd: '/workspace',
  runtime: 'unsafe arbitrary string',
  secret: 'DO_NOT_EXPOSE_SECRET',
  credentials: {
    google_cloud: {
      available: true, token_file_env: 'UNTRUSTED_ENV',
      token_file: '/tmp/awfl-google-access-token',
      token: 'LEAKED_GOOGLE_ACCESS_TOKEN',
      project: 'awfl-us',
      refresh_configured: true,
      cli_available: true,
    },
    github: {
      available: true, token_file: '/root/.aws/credentials',
      token: 'LEAKED_GITHUB_ACCESS_TOKEN',
      refresh_configured: true,
      cli_available: true,
    },
  },
  tools: { git: true, gcloud: true, python: true, node: true,
    chromium_playwright: true, private_secret: 'DO_NOT_EXPOSE' },
};

test('consumer environment is strictly allowlisted before Firestore storage', () => {
  const value = sanitizeEnvironment(candidate);
  assert.equal(value.cwd, '/workspace');
  assert.equal(value.runtime, 'shared_gke_python_consumer');
  assert.equal(value.credentials.google_cloud.available, true);
  assert.equal(value.credentials.google_cloud.project, 'awfl-us');
  assert.equal(value.credentials.google_cloud.token_file_env, 'CLOUDSDK_AUTH_ACCESS_TOKEN_FILE');
  assert.equal(value.credentials.google_cloud.token_file, '/tmp/awfl-google-access-token');
  assert.equal(value.credentials.github.token_file, null);
  assert.deepEqual(Object.keys(value.tools).sort(),
    ['chromium_playwright', 'gcloud', 'git', 'node', 'python', 'java', 'sbt'].sort());
  for (const secret of ['DO_NOT_EXPOSE', 'LEAKED_GOOGLE', 'LEAKED_GITHUB', '/root/.aws']) {
    assert.equal(JSON.stringify(value).includes(secret), false);
  }
});

test('invalid values cannot smuggle tokens through cwd/project or token path', () => {
  const value = sanitizeEnvironment({
    cwd: '/tmp\nSECRET',
    credentials: {
      google_cloud: { available: true, token_file: '/tmp/private-token',
        project: 'awfl-us\nSECRET' },
    },
    tools: { git: 'truthy-but-not-boolean' },
  });
  assert.equal(value.cwd, null);
  assert.equal(value.credentials.google_cloud.project, null);
  assert.equal(value.credentials.google_cloud.token_file, null);
  assert.equal(value.tools.git, false);
  assert.equal(sanitizeEnvironment(null), null);
});

test('MCP guide is consistent with authenticated AWFL key management and avoids secrets', () => {
  assert.match(ENVIRONMENT_GUIDE, /Firebase ID token/);
  assert.match(ENVIRONMENT_GUIDE, /AWFL_GITHUB_TOKEN_FILE/);
  assert.match(ENVIRONMENT_INSTRUCTIONS, /environment_status/);
  assert.doesNotMatch(ENVIRONMENT_GUIDE, /awfl_v1_[a-zA-Z0-9_-]{10,}/);
});

test('environment_status reports current heartbeat; stale heartbeat becomes unknown', async () => {
  const now = Date.now();
  const heartbeat = { consumerId: 'consumer-1', generation: 100, at: now,
    connected: true, capacity: 4, environment: sanitizeEnvironment(candidate),
    capabilities: ['shell', 'apply_patch'] };
  let lock = {
    consumerId: 'consumer-1', acquiredAt: 100,
    expiresAt: now + 60000, heartbeat,
    runtime: { mode: 'gke', namespace: 'awfl', consumerJobName: 'consumer-1' },
  };
  const service = new ExecutionService({
    db: {},
    ownerId: 'owner',
    getLock: async () => ({ lock }),
    inspectJob: async () => ({ state: 'active', active: 1 }),
  });
  let result = await service.status('owner', { projectId: 'p1', sessionId: 's1' });
  assert.equal(result.state, 'attached');
  assert.equal(result.environment.credentials.google_cloud.project, 'awfl-us');
  assert.equal(result.consumer.environment.credentials.github.available, true);
  assert.equal(result.environment_guide, 'awfl://environment/guide');
  lock = { ...lock, heartbeat: { ...heartbeat, at: now - 60000 } };
  result = await service.status('owner', { projectId: 'p1', sessionId: 's1' });
  assert.equal(result.state, 'starting');
  assert.equal(result.environment, null);
  assert.equal(result.consumer.environment, null);
});
