// Two separate Jobs HTTP instances sharing PostgreSQL must enforce one
// session owner. This test only accepts isolated loopback CI/local databases.
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import express from 'express';
import { PostgresStorage } from '../../storage/postgres/storage.js';
import { createFirebaseDbRouter } from '../../jobs/firebaseDbApi.js';

const connectionString = process.env.PGTEST_URL;
if (connectionString) {
  const url = new URL(connectionString);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !['/benchmark_ci', '/awfl_reconcile'].includes(url.pathname)) {
    throw new Error('Refusing non-isolated PostgreSQL database for lock test');
  }
}

test('independent Jobs instances serialize native session lock and owner release',
  { skip: !connectionString, timeout: 45000 }, async () => {
    const userId = 'native-lock-' + randomUUID().replaceAll('-', '');
    const projectId = 'reconcile-project';
    const id = 'session-' + randomUUID().replaceAll('-', '');
    const collection = 'locks';
    const path = `users/${userId}/projects/${projectId}/${collection}/${id}`;
    const instances = [];
    async function instance() {
      const pool = new pg.Pool({ connectionString, max: 4 });
      const storage = new PostgresStorage({ pool });
      await storage.initialize();
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.userId = userId;
        req.projectId = projectId;
        next();
      });
      app.use('/firebase', createFirebaseDbRouter({ getStorage: async () => storage }));
      const server = app.listen(0, '127.0.0.1');
      await new Promise(resolve => server.once('listening', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      const post = async (verb, owner, extra = {}) => {
        const response = await fetch(`${base}/firebase/locks/${verb}`, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({ collection, id, owner, ...extra }),
        });
        return { status: response.status, body: await response.json() };
      };
      const stop = async () => {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await storage.close();
        await pool.end();
      };
      instances.push({ storage, post, stop });
      return { storage, post };
    }
    try {
      const a = await instance();
      const b = await instance();
      const [first, second] = await Promise.all([
        a.post('acquire', 'worker-a', { ttlSeconds: 300 }),
        b.post('acquire', 'worker-b', { ttlSeconds: 300 }),
      ]);
      assert.deepEqual([first.status, second.status].sort(), [200, 409]);
      const winner = first.status === 200 ? 'worker-a' : 'worker-b';
      const loser = winner === 'worker-a' ? 'worker-b' : 'worker-a';
      assert.equal((await a.storage.get(path)).data.owner, winner);
      const wrongRelease = await b.post('release', loser);
      assert.equal(wrongRelease.status, 200);
      assert.equal(wrongRelease.body.released, false);
      assert.equal((await b.storage.get(path)).data.owner, winner);
      assert.equal((await a.post('release', winner)).body.released, true);
      const recovered = await b.post('acquire', loser, { ttlSeconds: 300 });
      assert.equal(recovered.status, 200);
      assert.equal(recovered.body.acquired, true);
      assert.equal((await a.storage.get(path)).data.owner, loser);
    } finally {
      if (instances.length) await instances[0].storage.delete(path);
      await Promise.all(instances.map(x => x.stop()));
    }
  });
