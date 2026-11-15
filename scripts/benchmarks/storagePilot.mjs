#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { FirestoreAtomicRecords } from '../../storage/pilot/adapters/firestore.js';
import { RealtimeAtomicRecords } from '../../storage/pilot/adapters/realtime.js';
import { PostgresAtomicRecords } from '../../storage/pilot/adapters/postgres.js';
import { NativeMemoryExecutionPilotStore } from '../../storage/pilot/memoryExecutionState.js';
import { PilotLatency } from '../../storage/pilot/metrics.js';

const backend = process.argv.find(arg=>arg.startsWith('--backend='))?.slice(10);
const runs = Number(process.argv.find(arg=>arg.startsWith('--runs='))?.slice(7) || 200);
const concurrency = Number(process.argv.find(arg=>arg.startsWith('--concurrency='))?.slice(14) || 1);
const warmup = Number(process.argv.find(arg=>arg.startsWith('--warmup='))?.slice(9) || 20);
if (!['firestore', 'rtdb', 'postgres'].includes(backend) || !Number.isInteger(runs) ||
  runs < 1 || runs > 100_000 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) {
  throw new Error('Usage: node scripts/benchmarks/storagePilot.mjs --backend=firestore|rtdb|postgres [--runs=200] [--concurrency=1|16]');
}
async function createBackend() {
  if (backend === 'firestore') {
    let db;
    if (process.env.GOOGLE_ACCESS_TOKEN_FILE && !process.env.FIRESTORE_EMULATOR_HOST) {
      // Use the exact injected user OAuth principal without granting the GKE
      // runtime broad Firestore IAM roles just for the benchmark.
      const { Firestore } = await import('@google-cloud/firestore');
      const { GoogleAuth, OAuth2Client } = await import('google-auth-library');
      const token = (await readFile(process.env.GOOGLE_ACCESS_TOKEN_FILE, 'utf8')).trim();
      if (!token) throw new Error('injected Firestore token file is empty');
      const oauth = new OAuth2Client();
      oauth.setCredentials({access_token:token, expiry_date:Date.now()+20*60_000});
      const auth = new GoogleAuth({projectId:process.env.GCP_PROJECT_ID || 'awfl-us'});
      // google-gax supports passing a GoogleAuth instance via Firestore's
      // settings. The public Admin SDK does not expose OAuth token injection.
      auth.getClient = async () => oauth;
      db = new Firestore({projectId:process.env.GCP_PROJECT_ID || 'awfl-us',auth});
    } else {
      const { initializeApp, getApps } = await import('firebase-admin/app');
      const { getFirestore } = await import('firebase-admin/firestore');
      if (!getApps().length) initializeApp({projectId:process.env.GCP_PROJECT_ID || 'awfl-us'});
      db = getFirestore();
    }
    return new FirestoreAtomicRecords({db,collection:'nativeStorageBenchmark'});
  }
  if (backend === 'rtdb') {
    const emulatorHost = process.env.RTDB_EMULATOR_HOST;
    if (emulatorHost) return new RealtimeAtomicRecords({
      databaseURL:`http://${emulatorHost}`,
      databaseNamespace:process.env.RTDB_EMULATOR_NAMESPACE || 'demo-awfl-default-rtdb',
      emulator:true,
    });
    if (!process.env.RTDB_DATABASE_URL) throw new Error('RTDB_DATABASE_URL is required');
    const tokenFile = process.env.GOOGLE_ACCESS_TOKEN_FILE;
    let auth;
    if (!tokenFile) {
      const { GoogleAuth } = await import('google-auth-library');
      auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/firebase.database',
        'https://www.googleapis.com/auth/userinfo.email'] });
    }
    const tokenProvider = tokenFile
      ? async () => (await readFile(tokenFile, 'utf8')).trim()
      : async () => auth.getAccessToken();
    return new RealtimeAtomicRecords({databaseURL:process.env.RTDB_DATABASE_URL,tokenProvider});
  }
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ host:process.env.PGHOST || '127.0.0.1',
    port:Number(process.env.PGPORT || 5432),
    user:process.env.PGUSER, database:process.env.PGDATABASE || 'awfl_bench',
    password:process.env.PGPASSWORD,
    max:Math.max(2, concurrency), connectionTimeoutMillis:15000,
    application_name:'awfl_storage_benchmark' });
  const store = new PostgresAtomicRecords({pool});
  await store.initialize();
  return store;
}
const records = await createBackend();
const store = new NativeMemoryExecutionPilotStore({records});
const timings = new PilotLatency();
const prefix = 'b' + Date.now().toString(36) + randomBytes(3).toString('hex');
const fixture = { userId:'bench-user', projectId:'bench-project',
  workflowName:'StoragePilot', artifactSha256:'a'.repeat(64),
  allowedOperations:['http.post'], protocolVersion:2, executionMode:'memory',
  input:{ tags:{kind:'bench'}, payload:'p'.repeat(1024) }};
let errors = [];
async function sequence(i, measure) {
  const key = `${prefix}_${i}`;
  const timing = (name, fn) => measure ? timings.measure(name, fn) : fn();
  try {
    await timing('state.create',()=>store.create({executionId:key,...fixture}));
    await timing('state.get',()=>store.get(key));
    const claim = await timing('state.claim',()=>store.claim({executionId:key,workerId:'bench-worker',
      leaseMs:60_000,expectedUserId:fixture.userId,expectedProjectId:fixture.projectId}));
    await timing('state.progress',()=>store.updateMemoryProgress({executionId:key,
      workerId:'bench-worker',epoch:claim.epoch,progress:{effectCount:1,step:1}}));
    await timing('state.complete',()=>store.complete({executionId:key,workerId:'bench-worker',epoch:claim.epoch,
      result:{ok:true,output:'r'.repeat(1024)},effectCount:1}));
    await timing('state.getCompleted',()=>store.get(key));
    await timing('raw.put',()=>records.put(`${key}_raw`,{value:'p'.repeat(1024)}));
    await timing('raw.get',()=>records.get(`${key}_raw`));
  } catch (err) {errors.push({at:i,code:err.code||err.name,message:err.message});}
  finally {
    await records.delete(key).catch(()=>{});
    await records.delete(`${key}_raw`).catch(()=>{});
  }
}
const begun = Date.now();
try {
  // Prime SDK auth, pool, and TCP/TLS setup before recording samples.
  for (let i=0;i<warmup;i++) await sequence(-i-1,false);
  const warmupFailures = errors.length;
  if (warmupFailures) {
    throw new Error(`${backend}: ${warmupFailures} warmup cycles failed: ${JSON.stringify(errors.slice(0, 3))}`);
  }
  const runIndex = { next:0 };
  await Promise.all(Array.from({length:concurrency}, async () => {
    while (runIndex.next<runs) {
      const i=runIndex.next++;
      await sequence(i,true);
    }
  }));
  const emulator = backend === 'firestore' ? Boolean(process.env.FIRESTORE_EMULATOR_HOST)
    : backend === 'rtdb' && Boolean(process.env.RTDB_EMULATOR_HOST);
  const localPostgres = backend === 'postgres' &&
    ['127.0.0.1', 'localhost', '::1'].includes(process.env.PGHOST || '127.0.0.1') &&
    !process.env.CLOUD_SQL_PROXY_INSTANCE;
  const environment = emulator ? 'firebase-emulator' : localPostgres ? 'postgres-local-or-proxy' : 'managed-gcp';
  const output={backend,environment,region: process.env.GCP_REGION || 'us-central1',
    runs,concurrency,warmup,durationMs:Date.now()-begun,
    latencyMs:timings.report(),failures:errors.length,
    errorExamples:errors.slice(0,5)};
  console.log(JSON.stringify(output,null,2));
  if (errors.length) process.exitCode=1;
} finally { await records.close(); }
