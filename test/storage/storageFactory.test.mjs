import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorage, selectedStorageBackend, storageBackendOf } from '../../storage/factory.js';
import { FirestoreStorage } from '../../storage/firestore/storage.js';
import { PostgresStorage } from '../../storage/postgres/storage.js';

const firestore = {
  doc: () => ({}), collection: () => ({}),
  collectionGroup: () => ({}), runTransaction: async () => {},
};
const pool = { query: async () => {}, connect: async () => {} };

test('default is firestore, explicit PostgreSQL selects Postgres only', async () => {
  assert.equal(selectedStorageBackend({}), 'firestore');
  assert.equal(selectedStorageBackend({ AWFL_DOCUMENT_STORAGE_BACKEND: 'postgres' }), 'postgres');
  assert.throws(() => selectedStorageBackend({ AWFL_DOCUMENT_STORAGE_BACKEND: 'postgre' }), /must be/);
  const f = createStorage({ firestoreDb: firestore, env: {} });
  const p = createStorage({ postgresPool: pool, env: { AWFL_DOCUMENT_STORAGE_BACKEND: 'postgres' } });
  assert.ok(f instanceof FirestoreStorage);
  assert.ok(p instanceof PostgresStorage);
  assert.equal(storageBackendOf(f), 'firestore');
  assert.equal(storageBackendOf(p), 'postgres');
  await f.close();
  await p.close();
});

test('missing provider clients fail immediately without fallback', () => {
  assert.throws(() => createStorage({ env: {} }), /Firestore database/);
  assert.throws(() => createStorage({ backend: 'postgres' }), /pg.Pool/);
  assert.throws(() => createStorage({ backend: 'sqlite' }), /unsupported storage/);
  assert.throws(() => storageBackendOf({}), /unrecognized Storage/);
});
