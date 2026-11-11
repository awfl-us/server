import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createNativeJobsRouter } from './native.js';

function appFor(underTest) {
  const app = express();
  app.use(express.json());
  // Simulate verified Cloud Run IAM + existing workflowsUserInject middleware.
  app.use((req, _res, next) => {
    req.userId = 'verified-user';
    req.projectId = 'project-a';
    next();
  });
  app.use('/native', createNativeJobsRouter(underTest));
  return app;
}

const previousEnabled = process.env.AWFL_NATIVE_EXECUTION_ENABLED;
process.env.AWFL_NATIVE_EXECUTION_ENABLED = '1';
test.after(() => {
  if (previousEnabled === undefined) delete process.env.AWFL_NATIVE_EXECUTION_ENABLED;
  else process.env.AWFL_NATIVE_EXECUTION_ENABLED = previousEnabled;
});

test('native Jobs endpoint is unavailable until explicitly enabled', async () => {
  const app = appFor({ store: {}, releases: {}, handlers: {},
    execute: async () => { throw new Error('should not execute'); },
  });
  delete process.env.AWFL_NATIVE_EXECUTION_ENABLED;
  try {
    assert.equal((await request(app).post('/native/execute')
      .send({ executionId: 'native_' + 'a'.repeat(32) })).status, 404);
  } finally {
    process.env.AWFL_NATIVE_EXECUTION_ENABLED = '1';
  }
});

test('internal Jobs native route executes only with verified task context', async () => {
  const calls = [];
  const app = appFor({
    store: {}, releases: {}, handlers: {},
    execute: async args => {
      calls.push(args);
      return { done: true };
    },
  });
  const id = 'native_' + 'a'.repeat(32);
  const res = await request(app).post('/native/execute')
    .send({ executionId: id, userId: 'spoofed', projectId: 'wrong' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { state: 'SUCCEEDED', result: { done: true } });
  assert.equal(calls[0].userId, 'verified-user');
  assert.equal(calls[0].projectId, 'project-a');
  assert.equal(calls[0].executionId, id);
  assert.equal(calls.length, 1);
  assert.equal((await request(app).post('/native/execute')
    .send({ executionId: '../escape' })).status, 400);
  assert.equal(calls.length, 1);
});

test('failed native Jobs worker returns retriable error without exposing details', async () => {
  const app = appFor({
    store: {}, releases: {}, handlers: {},
    execute: async () => { throw new Error('sensitive internal credential'); },
  });
  const res = await request(app).post('/native/execute')
    .send({ executionId: 'native_' + 'b'.repeat(32) });
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'Native execution unavailable');
  assert.equal(JSON.stringify(res.body).includes('sensitive'), false);
});
