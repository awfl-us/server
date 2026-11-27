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

// Shared IAM/TLS configuration for document and separately budgeted live pools.
export async function createPostgresConnectionOptions(env=process.env) {
  if (env.AWFL_CLOUD_SQL_INSTANCE) {
    if (env.AWFL_POSTGRES_URL || env.PGHOST) throw new Error('Cloud SQL IAM and explicit PostgreSQL host/URL are mutually exclusive');
    if (!env.AWFL_POSTGRES_IAM_USER || !env.AWFL_POSTGRES_DB) throw new Error('Cloud SQL IAM requires AWFL_POSTGRES_IAM_USER and AWFL_POSTGRES_DB');
    const {Connector}=await import('@google-cloud/cloud-sql-connector');
    const connector=new Connector();
    try {
      const options=await connector.getOptions({instanceConnectionName:env.AWFL_CLOUD_SQL_INSTANCE,authType:'IAM'});
      return {options:{...options,user:env.AWFL_POSTGRES_IAM_USER,database:env.AWFL_POSTGRES_DB},connector};
    } catch(error){connector.close();throw error;}
  }
  const connectionString=env.AWFL_POSTGRES_URL;
  if(!connectionString&&(!env.PGHOST||!env.PGUSER||!env.PGDATABASE))throw new Error('PostgreSQL connection is not configured for native memory workflows');
  return {options:connectionString?{connectionString}:{host:env.PGHOST,port:Number(env.PGPORT||5432),user:env.PGUSER,database:env.PGDATABASE,password:env.PGPASSWORD},connector:null};
}

export async function createNativeMemoryStore({
  env=process.env, firestoreDb, postgresPool, ownPool=false,
}={}) {
  const backend=selectedStorageBackend(env);
  let db=firestoreDb, pool=postgresPool, connector=null;
  if (backend==='firestore' && !db) {
    const { getFirestore }=await import('firebase-admin/firestore');
    db=getFirestore();
  }
  if (backend==='postgres' && !pool) {
    const {default:pg}=await import('pg');
    const max=Number(env.AWFL_POSTGRES_POOL_SIZE || 3);
    if (!Number.isSafeInteger(max) || max<1 || max>5) {
      throw new TypeError('AWFL_POSTGRES_POOL_SIZE must be 1..5');
    }
    const connection=await createPostgresConnectionOptions(env);
    connector=connection.connector;
    try {
      pool=new pg.Pool({...connection.options,max,connectionTimeoutMillis:15000,application_name:'awfl_native_memory'});
    } catch(error) {connector?.close();throw error;}
    ownPool=true;
  }
  const storage=createStorage({backend,firestoreDb:db,postgresPool:pool,ownPool,liveNotifications:env.AWFL_LIVE_RESPONSES_ENABLED==='1'&&env.AWFL_LIVE_RESPONSES_TRANSPORT==='shared'});
  const records=new DocumentAtomicRecords({storage,collection:'nativeWorkflowExecutions'});
  return {backend,storage,store:new NativeMemoryExecutionPilotStore({records}),
    close: async () => { try { await storage.close(); } finally { connector?.close(); } },
  };
}

// One provider/client pool per process serves Jobs CRUD and native memory
// execution. A separate singleton per caller doubles SQL connections.
let configuredPromise;
export function configuredNativeComponents(clients) {
  configuredPromise ||= createNativeMemoryStore(clients).catch(error => {
    configuredPromise = null;
    throw error;
  });
  return configuredPromise;
}
export async function configuredNativeMemoryStore() {
  if (!nativeDocumentStoreEnabled()) return null;
  // Durable Firestore effect journals are separate from memory-root execution.
  // All execution paths must use the same selected backend per root.
  if (process.env.AWFL_NATIVE_MEMORY_EXECUTION_ENABLED !== '1') {
    throw new Error('native document Storage requires memory execution enabled');
  }
  return (await configuredNativeComponents()).store;
}
