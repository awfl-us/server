import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createNativeCallbackEffects, nativeCallbackIdFromUrl,
  registerNativeCallback, recordNativeCallbackDelivery,
} from './callbackEffects.js';

const origin = 'https://jobs.example.org';
const identity = { userId: 'owner', projectId: 'project-a' };
const idempotencyKey = 'native_' + 'a'.repeat(32) + ':create_effect';

function fakeDb() {
  const records = new Map();
  const watchers = new Map();
  const makeRef = path => ({
    path,
    async get() { return snap(path); },
    onSnapshot(notify, fail) {
      if (!watchers.has(path)) watchers.set(path, new Set());
      watchers.get(path).add(notify);
      queueMicrotask(() => notify(snap(path)));
      return () => watchers.get(path).delete(notify);
    },
  });
  const snap = path => ({
    exists: records.has(path),
    data: () => records.get(path),
  });
  return {
    records,
    watchers,
    doc: makeRef,
    async runTransaction(work) {
      return work({
        get: async ref => snap(ref.path),
        create: (ref, value) => { records.set(ref.path, value); },
        update: (ref, patch) => { records.set(ref.path, {
          ...records.get(ref.path), ...patch,
        }); },
      });
    },
    deliver(path, body) {
      const value = records.get(path);
      assert.ok(value);
      records.set(path, { ...value, called_at: Date.now(),
        native_result_json: JSON.stringify(body) });
      for (const notify of watchers.get(path) || []) notify(snap(path));
    },
  };
}

test('callback.create reuses the existing user-scoped collection with stable ID', async () => {
  const db = fakeDb();
  const callbacks = createNativeCallbackEffects({ db, jobsOrigin: origin });
  const args = { http_callback_method: 'POST' };
  const first = await callbacks['callback.create']({ args, identity, idempotencyKey });
  const second = await callbacks['callback.create']({ args, identity, idempotencyKey });
  assert.deepEqual(first, second);
  assert.equal(db.records.size, 1);
  const id = nativeCallbackIdFromUrl(first.url, origin);
  assert.match(id, /^n[a-f0-9]{32}$/);
  const saved = db.records.get('users/owner/callbacks/' + id);
  assert.equal(saved.kind, 'native_workflow');
  assert.equal(saved.native_project_id, identity.projectId);
  assert.equal(saved.native_execution_id, idempotencyKey.split(':')[0]);
  assert.equal(nativeCallbackIdFromUrl(first.url, 'https://evil.org'), null);
  assert.equal(nativeCallbackIdFromUrl(first.url + '?target=evil', origin), null);
  await assert.rejects(callbacks['callback.create']({
    args, identity: { ...identity, userId: 'evil/bad' }, idempotencyKey,
  }));
});

test('callback.await consumes delivery from existing record, before or after subscription', async () => {
  const db = fakeDb();
  const callbacks = createNativeCallbackEffects({ db, jobsOrigin: origin });
  const { url } = await callbacks['callback.create']({
    args: { http_callback_method: 'POST' }, identity, idempotencyKey,
  });
  const id = nativeCallbackIdFromUrl(url, origin);
  const path = 'users/owner/callbacks/' + id;
  const waiting = callbacks['callback.await']({
    args: { callback: { url }, timeout: 10 }, identity,
  });
  await Promise.resolve();
  db.deliver(path, { ok: true, nested: [1, 'two'] });
  assert.deepEqual(await waiting, {
    http_request: { body: { ok: true, nested: [1, 'two'] } },
  });
  assert.deepEqual(await callbacks['callback.await']({
    args: { callback: { url }, timeout: 10 }, identity,
  }), { http_request: { body: { ok: true, nested: [1, 'two'] } } });
  assert.equal(db.watchers.get(path).size, 0);
});

test('callback.await enforces owner, project, method and timeout', async () => {
  const db = fakeDb();
  const handlers = createNativeCallbackEffects({ db, jobsOrigin: origin });
  const { url } = await handlers['callback.create']({
    args: { http_callback_method: 'POST' }, identity, idempotencyKey,
  });
  for (const badIdentity of [
    { userId: 'other', projectId: 'project-a' },
    { userId: 'owner', projectId: 'other' },
  ]) {
    await assert.rejects(handlers['callback.await']({
      args: { callback: { url }, timeout: 1 }, identity: badIdentity,
    }));
  }
  await assert.rejects(handlers['callback.create']({
    args: { http_callback_method: 'DELETE' }, identity, idempotencyKey,
  }));
  await assert.rejects(handlers['callback.await']({
    args: { callback: { url }, timeout: 7200 }, identity,
  }));
});

test('existing Jobs callbacks registration returns the same native ID', async () => {
  const db = fakeDb();
  const callbacks = createNativeCallbackEffects({ db, jobsOrigin: origin });
  const { url } = await callbacks['callback.create']({
    args: { http_callback_method: 'POST' }, identity, idempotencyKey,
  });
  const registered = await registerNativeCallback({
    db, callbackUrl: url, jobsOrigin: origin, identity,
  });
  assert.equal(registered.id, nativeCallbackIdFromUrl(url, origin));
  assert.equal(registered.callback_url, url);
  assert.equal(db.records.size, 1);
  await assert.rejects(registerNativeCallback({
    db, callbackUrl: url, jobsOrigin: origin,
    identity: { userId: 'other-user', projectId: 'project-a' },
  }));
});

test('existing Jobs callback route records one delivery; duplicate is idempotent', async () => {
  const db = fakeDb();
  const callbacks = createNativeCallbackEffects({ db, jobsOrigin: origin });
  const { url } = await callbacks['callback.create']({
    args: { http_callback_method: 'POST' }, identity, idempotencyKey,
  });
  const path = 'users/owner/callbacks/' + nativeCallbackIdFromUrl(url, origin);
  const ref = db.doc(path);
  const body = { status: 'ok', output: 'received' };
  assert.equal(await recordNativeCallbackDelivery({
    db, ref, body, identity,
  }), 'recorded');
  assert.equal(await recordNativeCallbackDelivery({
    db, ref, body, identity,
  }), 'duplicate');
  assert.equal(JSON.parse(db.records.get(path).native_result_json).output, 'received');
  await assert.rejects(recordNativeCallbackDelivery({
    db, ref, body: { different: true }, identity,
  }), /already delivered/);
  await assert.rejects(recordNativeCallbackDelivery({
    db, ref, body, identity: { ...identity, projectId: 'other' },
  }), /inaccessible/);
});
