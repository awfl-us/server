import { createStorage, selectedStorageBackend } from './factory.js';
import { DocumentAtomicRecords } from './document/atomicRecords.js';
import { NativeMemoryExecutionPilotStore } from './pilot/memoryExecutionState.js';

/**
 * Explicitly experimental native-memory composition. All API/Jobs services
 * must share both this flag AND provider configuration. It must not be
 * enabled on an existing live deployment before draining/migrating runs.
 */
export function nativeDocumentStoreEnabled(env=process.env) {
  return env.AWFL_NATIVE_DOCUMENT_STORE_ENABLED === '1';
}

export async function createNativeMemoryStore({
  env=process.env, firestoreDb, postgresPool, ownPool=false,
}={}) {
  const backend=selectedStorageBackend(env);
  let db=firestoreDb, pool=postgresPool;
  if (backend==='firestore' && !db) {
    const { getFirestore }=await import('firebase-admin/firestore');
    db=getFirestore();
  }
  if (backend==='postgres' && !pool) {
    const {default:pg}=await import('pg');
    const max=Number(env.AWFL_POSTGRES_POOL_SIZE || 2);
    if (!Number.isSafeInteger(max) || max<1 || max>5) {
      throw new TypeError('AWFL_POSTGRES_POOL_SIZE must be 1..5');
    }
    // All PGHOST/PGPORT/PGUSER/PGDATABASE/PGPASSWORD or DATABASE_URL must
    // be provisioned consistently across API, Jobs, and GKE worker services.
    // Cloud SQL IAM auth is provided by the deployment's SQL connector/proxy.
    const connectionString=env.AWFL_POSTGRES_URL;
    if (!connectionString && (!env.PGHOST || !env.PGUSER || !env.PGDATABASE)) {
      throw new Error('PostgreSQL connection is not configured for native memory workflows');
    }
    pool=new pg.Pool({
      ...(connectionString ? {connectionString} : {
        host:env.PGHOST,port:Number(env.PGPORT || 5432),
        user:env.PGUSER,database:env.PGDATABASE,password:env.PGPASSWORD,
      }),
      max,connectionTimeoutMillis:15000,application_name:'awfl_native_memory',
    });
    ownPool=true;
  }
  const storage=createStorage({backend,firestoreDb:db,postgresPool:pool,ownPool});
  const records=new DocumentAtomicRecords({storage,collection:'nativeWorkflowExecutions'});
  return {backend,storage,store:new NativeMemoryExecutionPilotStore({records})};
}

let configuredPromise;
export async function configuredNativeMemoryStore() {
  if (!nativeDocumentStoreEnabled()) return null;
  // Explicitly fail closed: this small state machine supports only native
  // memory roots, not durable journals or detached-resume scans.
  if (process.env.AWFL_NATIVE_MEMORY_EXECUTION_ENABLED !== '1') {
    throw new Error('native document Storage requires memory execution enabled');
  }
  configuredPromise ||= createNativeMemoryStore();
  return (await configuredPromise).store;
}
