import { assertStorage } from './document/contract.js';
import { FirestoreStorage } from './firestore/storage.js';
import { PostgresStorage } from './postgres/storage.js';

/**
 * Configuration is resolved ONCE at each service composition root, never per
 * workflow step. All roles touching the same execution must share the same
 * provider selection and point at the same database.
 */
export function selectedStorageBackend(env = process.env) {
  const name = env.AWFL_DOCUMENT_STORAGE_BACKEND ?? 'firestore';
  if (name !== 'firestore' && name !== 'postgres') {
    throw new TypeError(
      'AWFL_DOCUMENT_STORAGE_BACKEND must be firestore or postgres',
    );
  }
  return name;
}

/**
 * Inject already initialized database clients. No Firebase SDK is imported
 * by domain code, and no SQL connections or GCP credentials are created here.
 * Caller owns clients by default and may opt into adapter-managed shutdown.
 */
export function createStorage({
  backend,
  env = process.env,
  firestoreDb,
  postgresPool,
  ownDb = false,
  ownPool = false,
  pollIntervalMs,
  liveNotifications=false,
} = {}) {
  const provider = backend ?? selectedStorageBackend(env);
  if (provider === 'firestore') {
    return assertStorage(new FirestoreStorage({ db: firestoreDb, ownDb }));
  }
  if (provider === 'postgres') {
    return assertStorage(new PostgresStorage({
      pool: postgresPool, ownPool, pollIntervalMs, liveNotifications,
    }));
  }
  throw new TypeError('unsupported storage backend');
}

/**
 * Explicitly records provider selection for APIs that pass a Storage object
 * across multiple service layers. Existing Firestore-native execution store
 * must be converted before routing its records through PostgreSQL.
 */
export function storageBackendOf(storage) {
  if (storage instanceof FirestoreStorage) return 'firestore';
  if (storage instanceof PostgresStorage) return 'postgres';
  throw new TypeError('unrecognized Storage implementation');
}
