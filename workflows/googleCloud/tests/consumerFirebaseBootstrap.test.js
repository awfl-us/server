import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { createConsumerCredentialsRouter } from '../consumerRefresh.js';
import { classifyK8sJob } from '../../../jobs/producer/jobStatus.js';

const capability = 'a'.repeat(64);
const consumerId = 'consumer-example';
const userId = 'user-example';
const projectId = 'project-example';
const jobName = 'consumer-consumer-example';

function setup({ lock = null, grantConsumerId = consumerId, grantHash = createHash('sha256').update(capability).digest('hex'),
  jobState = 'active', job = null, mintFailure = false } = {}) {
  const observed = { mintCalls: [], inspectedJobs: [], readProjects: [], google: 0 };
  const app = express();
  app.use(express.json());
  app.use('/consumer-credentials', createConsumerCredentialsRouter({
    readProject: async (u, p) => {
      observed.readProjects.push([u, p]);
      return { exists: true, data: () => ({ consumerLock: lock,
        consumerCredentialRefresh: { consumerId: grantConsumerId, hash: grantHash } }) };
    },
    inspectJob: async args => {
      observed.inspectedJobs.push(args);
      return { state: job ? classifyK8sJob(job) : jobState };
    },
    mintFirebase: async ({ uid }) => {
      observed.mintCalls.push(uid);
      if (mintFailure) throw new Error('injected failure');
      return 'fresh-custom-token';
    },
    resolveGoogle: async () => { observed.google++; return null; },
    resolveGithub: async () => null,
    getDb: () => ({ mocked: true }),
  }));
  const call = async (path = '/firebase', secret = capability) =>
    request(app).post('/consumer-credentials' + path)
      .set('x-awfl-consumer-credential', secret)
      .send({ userId, projectId, consumerId });
  return { call, observed };
}

test('fresh token bootstraps on the same live job after SIGTERM released its lock', async () => {
  const { call, observed } = setup({ lock: null });
  const res = await call();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { customToken: 'fresh-custom-token' });
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(observed.inspectedJobs, [{namespace:process.env.K8S_NAMESPACE || 'awfl',jobName}]);
  assert.deepEqual(observed.mintCalls, [userId]);
});

test('normal same-consumer lock permits Firebase bootstrap', async () => {
  const { call } = setup({ lock: {consumerId,expiresAt:Date.now()+60_000} });
  assert.equal((await call()).status,200);
});

test('expired own lock allows restart while Kubernetes job still exists', async () => {
  const { call } = setup({ lock: {consumerId,expiresAt:Date.now()-60000} });
  assert.equal((await call()).status,200);
});

test('active newer lock blocks stale consumer even when its old job is live', async () => {
  const { call, observed } = setup({ lock: {consumerId:'consumer-newer',expiresAt:Date.now()+60000} });
  assert.equal((await call()).status,403);
  assert.deepEqual(observed.mintCalls, []);
  assert.deepEqual(observed.inspectedJobs, []);
});

test('replaced grant blocks previous consumer', async () => {
  const { call, observed } = setup({ grantConsumerId:'consumer-newer' });
  assert.equal((await call()).status,403);
  assert.deepEqual(observed.mintCalls,[]);
});

test('missing or incorrect capability is rejected without Kubernetes lookup', async () => {
  const { call, observed } = setup();
  assert.equal((await call('/firebase','bad')).status,401);
  assert.equal((await call('/firebase','b'.repeat(64))).status,403);
  assert.deepEqual(observed.inspectedJobs,[]);
});

test('completed or deleted Jobs cannot obtain new Firebase tokens', async () => {
  for (const jobState of ['completed','failed','terminating','not_found','unavailable']) {
    const { call, observed } = setup({jobState});
    assert.equal((await call()).status,403,jobState);
    assert.deepEqual(observed.mintCalls,[]);
  }
});

test('original refresh endpoint remains lock-bound', async () => {
  const { call, observed } = setup({ lock: null });
  assert.equal((await call('/refresh')).status,403);
  assert.equal(observed.google,0);
});

test('broker never exposes minting failures or secrets to caller', async () => {
  const { call } = setup({ mintFailure:true });
  const result = await call();
  assert.equal(result.status,503);
  assert.ok(!JSON.stringify(result.body).includes('injected'));
});

test('live job may bootstrap even while new pod is pending', async () => {
  const { call } = setup({jobState:'pending'});
  assert.equal((await call()).status,200);
});

test('evicted GKE Job may mint a new token while replacement pod is active', async () => {
  const { call, observed } = setup({ job: {
    status: { failed: 1, active: 1 },
    spec: { backoffLimit: 3 },
  } });
  const res = await call();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(observed.mintCalls, [userId]);
});

test('a genuinely failed GKE Job cannot mint a replacement token', async () => {
  const { call, observed } = setup({ job: {
    status: { failed: 4, active: 0, conditions: [
      { type: 'Failed', status: 'True' },
    ] },
    spec: { backoffLimit: 3 },
  } });
  assert.equal((await call()).status, 403);
  assert.deepEqual(observed.mintCalls, []);
});
