import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createNativeCallbackEffects, nativeCallbackIdFromUrl,
  registerNativeCallback, recordNativeCallbackDelivery,
  nativeCallbacksUseLegacyFirestore,
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


test('native callbacks keep Firestore root provenance during the PostgreSQL CRUD transition', () => {
  assert.equal(nativeCallbacksUseLegacyFirestore({
    AWFL_DOCUMENT_STORAGE_BACKEND:'postgres',
    AWFL_NATIVE_DOCUMENT_STORE_ENABLED:'0',
  }), true);
  assert.equal(nativeCallbacksUseLegacyFirestore({
    AWFL_DOCUMENT_STORAGE_BACKEND:'firestore',
    AWFL_NATIVE_DOCUMENT_STORE_ENABLED:'0',
  }), true);
  assert.equal(nativeCallbacksUseLegacyFirestore({
    AWFL_DOCUMENT_STORAGE_BACKEND:'postgres',
    AWFL_NATIVE_DOCUMENT_STORE_ENABLED:'1',
  }), false);
});

// Exercise the provider-neutral (PostgreSQL) route independently of the legacy
// Firestore mock. A subscription must report its initial persisted snapshot:
// delivery can commit after callback.await's first get but before LISTEN starts.
function fakeStorage() {
  const documents = new Map();
  const listeners = new Map();
  let transactionTail = Promise.resolve();
  let reads = 0;
  let afterGet = null;
  const doc = path => documents.has(path)
    ? { path, data: structuredClone(documents.get(path)) } : null;
  const emit = path => {
    for (const listener of listeners.get(path) || []) {
      listener({ type: 'change', value: doc(path) });
    }
  };
  const storage = {
    documents, listeners,
    get reads() { return reads; },
    set afterGet(fn) { afterGet = fn; },
    async get(path) {
      reads++;
      const result = doc(path);
      if (afterGet) { const fn = afterGet; afterGet = null; await fn(); }
      return result;
    },
    async transaction(work) {
      const prior = transactionTail;
      let release;
      transactionTail = new Promise(resolve => { release = resolve; });
      await prior;
      try {
        return await work({
          get: async path => doc(path),
          create: async (path, data) => {
            assert.ok(!documents.has(path));
            documents.set(path, structuredClone(data)); emit(path);
          },
          update: async (path, patch) => {
            assert.ok(documents.has(path));
            documents.set(path, { ...documents.get(path), ...structuredClone(patch) });
            emit(path);
          },
        });
      } finally { release(); }
    },
    async subscribe(path, listener) {
      if (!listeners.has(path)) listeners.set(path, new Set());
      listeners.get(path).add(listener);
      // Matches both the PostgresStorage and FirestoreStorage contract: the
      // initial snapshot is delivered *after* the listener is registered.
      await listener({ type: 'snapshot', value: doc(path) });
      return async () => { listeners.get(path).delete(listener); };
    },
  };
  return storage;
}

test('storage-backed native callbacks create once and atomically accept one delivery', async () => {
  const storage = fakeStorage();
  const handlers = createNativeCallbackEffects({ storage, jobsOrigin: origin });
  const args = { http_callback_method: 'POST' };
  const [first, second] = await Promise.all([
    handlers['callback.create']({ args, identity, idempotencyKey }),
    handlers['callback.create']({ args, identity, idempotencyKey }),
  ]);
  assert.deepEqual(first, second);
  assert.equal(storage.documents.size, 1);
  assert.deepEqual(await registerNativeCallback({
    storage, callbackUrl: first.url, jobsOrigin: origin, identity,
  }), { id: nativeCallbackIdFromUrl(first.url, origin), callback_url: first.url });
  const path = 'users/owner/callbacks/' + nativeCallbackIdFromUrl(first.url, origin);
  const body = { ok: true, value: [1, 2] };
  assert.deepEqual(await Promise.all([
    recordNativeCallbackDelivery({ storage, ref: path, body, identity }),
    recordNativeCallbackDelivery({ storage, ref: path, body, identity }),
  ]).then(results => results.sort()), ['duplicate', 'recorded']);
  assert.equal(storage.documents.get(path).native_result_json, JSON.stringify(body));
  await assert.rejects(recordNativeCallbackDelivery({
    storage, ref: path, body: { ok: false }, identity,
  }), /already delivered/);
  await assert.rejects(recordNativeCallbackDelivery({
    storage, ref: path, body, identity: { ...identity, projectId: 'wrong' },
  }), /inaccessible/);
  assert.deepEqual(await handlers['callback.await']({
    args: { callback: first, timeout: 1 }, identity,
  }), { http_request: { body } });
});

test('storage callback await survives delivery between initial get and subscription', async () => {
  const storage = fakeStorage();
  const handlers = createNativeCallbackEffects({ storage, jobsOrigin: origin });
  const callback = await handlers['callback.create']({
    args: { http_callback_method: 'POST' }, identity, idempotencyKey,
  });
  const path = 'users/owner/callbacks/' + nativeCallbackIdFromUrl(callback.url, origin);
  storage.afterGet = async () => {
    await recordNativeCallbackDelivery({ storage, ref: path,
      body: { phase: 'between-get-and-listen' }, identity });
  };
  assert.deepEqual(await handlers['callback.await']({
    args: { callback, timeout: 1 }, identity,
  }), { http_request: { body: { phase: 'between-get-and-listen' } } });
  assert.equal(storage.listeners.get(path).size, 0, 'initial snapshot must unsubscribe');
});

test('storage callback await unsubscribes after live delivery and after timeout', async () => {
  const storage = fakeStorage();
  const handlers = createNativeCallbackEffects({ storage, jobsOrigin: origin });
  const callback = await handlers['callback.create']({
    args: { http_callback_method: 'POST' }, identity, idempotencyKey,
  });
  const path = 'users/owner/callbacks/' + nativeCallbackIdFromUrl(callback.url, origin);
  const waiting = handlers['callback.await']({
    args: { callback, timeout: 2 }, identity,
  });
  // Wait for subscription registration before delivering the callback.
  for (let i = 0; !storage.listeners.get(path)?.size && i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(storage.listeners.get(path)?.size, 1);
  await recordNativeCallbackDelivery({ storage, ref: path, body: { ok: 1 }, identity });
  assert.deepEqual(await waiting, { http_request: { body: { ok: 1 } } });
  assert.equal(storage.listeners.get(path).size, 0);

  const other = await handlers['callback.create']({
    args: { http_callback_method: 'POST' }, identity,
    idempotencyKey: 'native_' + 'b'.repeat(32) + ':create_effect',
  });
  await assert.rejects(handlers['callback.await']({
    args: { callback: other, timeout: 1 }, identity,
  }), /exceeded Jobs deadline/);
  const otherPath = 'users/owner/callbacks/' + nativeCallbackIdFromUrl(other.url, origin);
  assert.equal(storage.listeners.get(otherPath).size, 0);
});
