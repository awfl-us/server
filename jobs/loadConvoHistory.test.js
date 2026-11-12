import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { workflowsUserInject } from './userAuth.js';
import { createLoadConvoHistoryRouter } from './loadConvoHistory.js';

test('Google Workflows HTTP POST uses middleware-authenticated user after body identity is stripped', async () => {
  const writes = [];
  const records = [{
    conversation_id: 'synthetic-conversation-1',
    title: 'Synthetic conversation',
    mapping: {
      root: { id: 'root', children: [], message: {
        id: 'synthetic-message-1',
        author: { role: 'user' },
        content: { parts: ['hello'] },
      } },
    },
  }];
  const storage = {
    bucket: name => {
      assert.equal(name, 'topaigents-gpt-convo-history');
      return { file: key => {
        assert.equal(key, 'synthetic.json');
        return { download: async () => [Buffer.from(JSON.stringify(records))] };
      } };
    },
  };
  const db = {
    collection: name => ({
      doc: id => ({ set: async (data) => writes.push({ name, id, data }) }),
    }),
    batch: () => ({
      set: (ref, data) => writes.push({ kind: 'message', data }),
      commit: async () => {},
    }),
  };
  const app = express();
  app.use(express.json());
  app.use(workflowsUserInject);
  app.use('/convo-history', createLoadConvoHistoryRouter({ storage, db }));

  const response = await request(app)
    .post('/convo-history/loadConvoHistory')
    .set('x-user-id', 'synthetic-user')
    .set('x-project-id', 'synthetic-project')
    .send({ objectName: 'synthetic.json', userId: 'synthetic-user' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    loaded: 1, sessions: 1, discarded_messages: 0,
  });
  assert.equal(writes.find(w => w.id === 'synthetic-conversation-1')?.data.user_id,
    'synthetic-user');
  assert.equal(writes.filter(w => w.kind === 'message').length, 1);
});

test('missing authenticated identity fails before accessing GCS', async () => {
  const app = express();
  app.use(express.json());
  app.use(workflowsUserInject);
  app.use('/convo-history', createLoadConvoHistoryRouter({
    storage: { bucket: () => { throw new Error('must not be called'); } },
    db: {},
  }));
  const response = await request(app)
    .post('/convo-history/loadConvoHistory')
    .send({ objectName: 'synthetic.json' });
  assert.equal(response.status, 401);
});
