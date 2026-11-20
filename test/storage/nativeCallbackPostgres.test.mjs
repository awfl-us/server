// Real PostgreSQL cross-client native callback test; never use production DB.
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {PostgresStorage} from '../../storage/postgres/storage.js';
import {createNativeCallbackEffects, nativeCallbackIdFromUrl,
  recordNativeCallbackDelivery} from '../../workflows/native/callbackEffects.js';

const connectionString = process.env.PGTEST_URL;
if (connectionString) {
  const url = new URL(connectionString);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !['/benchmark_ci', '/awfl_reconcile'].includes(url.pathname)) {
    throw new Error('Refusing non-isolated PostgreSQL database for callback test');
  }
}
const jobsOrigin = 'https://jobs.test.example';
async function client() {
  const pool = new pg.Pool({connectionString, max: 5});
  const storage = new PostgresStorage({pool});
  await storage.initialize();
  return {pool, storage};
}

test('independent PostgreSQL clients atomically deliver and wake native callback',
  {skip: !connectionString, timeout: 45000}, async () => {
    const identity = {userId: 'native-callback-' + randomUUID().replaceAll('-', ''),
      projectId: 'reconcile-project'};
    const executionId = 'native_' + randomUUID().replaceAll('-', '');
    const a = await client();
    const b = await client();
    const callbackA = createNativeCallbackEffects({storage: a.storage, jobsOrigin});
    const callbackB = createNativeCallbackEffects({storage: b.storage, jobsOrigin});
    let path;
    try {
      const intent = {args: {http_callback_method: 'POST'}, identity,
        idempotencyKey: executionId + ':callback'};
      const [first, second] = await Promise.all([
        callbackA['callback.create'](intent), callbackB['callback.create'](intent),
      ]);
      assert.deepEqual(first, second);
      path = `users/${identity.userId}/callbacks/${nativeCallbackIdFromUrl(first.url, jobsOrigin)}`;
      const body = {result: 'ok', nested: {count: 2}};
      // Prove that delivery comes AFTER the independent reader's LISTEN has
      // installed its initial snapshot, rather than merely hitting the
      // already-delivered fast path in callback.await.
      const originalSubscribe = a.storage.subscribe.bind(a.storage);
      let subscriptionReady;
      const subscribed = new Promise(resolve => { subscriptionReady = resolve; });
      a.storage.subscribe = async (...args) => {
        const unsubscribe = await originalSubscribe(...args);
        subscriptionReady();
        return unsubscribe;
      };
      const waiting = callbackA['callback.await']({
        args: {callback: first, timeout: 5}, identity,
      });
      await subscribed;
      const deliveries = await Promise.all([
        recordNativeCallbackDelivery({storage: a.storage, ref: path, body, identity}),
        recordNativeCallbackDelivery({storage: b.storage, ref: path, body, identity}),
      ]);
      assert.deepEqual(deliveries.sort(), ['duplicate', 'recorded']);
      assert.deepEqual(await waiting, {http_request: {body}});
      assert.equal((await b.storage.get(path)).data.native_result_json, JSON.stringify(body));
      await assert.rejects(recordNativeCallbackDelivery({
        storage: b.storage, ref: path, body: {result: 'conflict'}, identity,
      }), /Callback already delivered/);
      await assert.rejects(recordNativeCallbackDelivery({
        storage: b.storage, ref: path, body,
        identity: {...identity, projectId: 'other'},
      }), /Callback inaccessible/);
      assert.deepEqual(await callbackB['callback.await']({
        args: {callback: first, timeout: 5}, identity,
      }), {http_request: {body}});
    } finally {
      if (path) await a.storage.delete(path);
      await Promise.all([a.storage.close(), b.storage.close()]);
      await Promise.all([a.pool.end(), b.pool.end()]);
    }
  });
