import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {Firestore} from '@google-cloud/firestore';
import {GoogleAuth,OAuth2Client} from 'google-auth-library';
import {createNativeMemoryStore} from '../../storage/nativeMemory.js';

let firestore;
after(async()=>{await firestore?.terminate();});
const tokenFile=process.env.GOOGLE_ACCESS_TOKEN_FILE || process.env.CLOUDSDK_AUTH_ACCESS_TOKEN_FILE;
async function makeFirestore() {
  if(firestore) return firestore;
  if(process.env.FIRESTORE_EMULATOR_HOST) return firestore=new Firestore({projectId:'demo-awfl-storage-test'});
  const token=(await readFile(tokenFile,'utf8')).trim();
  const oauth=new OAuth2Client();
  oauth.setCredentials({access_token:token,expiry_date:Date.now()+20*60_000});
  const auth=new GoogleAuth({projectId:'awfl-us'});auth.getClient=async()=>oauth;
  return firestore=new Firestore({projectId:'awfl-us',auth});
}
async function exercise({env,firestoreDb,postgresPool,initializeSchema=false}) {
  const {store,storage,backend}=await createNativeMemoryStore({env,firestoreDb,postgresPool});
  if(initializeSchema) await storage.initialize(); // integration test fixture only; never at application startup
  const executionId='native_'+randomUUID().replaceAll('-','');
  const project='p',userId='u';
  try {
    await store.create({executionId,userId,projectId:project,workflowName:'Test',
      artifactSha256:'a'.repeat(64),input:{x:1},allowedOperations:[]});
    assert.equal((await store.get(executionId)).status,'ready');
    const contender=await Promise.allSettled(Array.from({length:6},(_,i)=>store.claim({
      executionId,workerId:'worker'+i,expectedUserId:userId,
      expectedProjectId:project,leaseMs:60000,
    })));
    assert.equal(contender.filter(x=>x.status==='fulfilled').length,1);
    const owner=contender.find(x=>x.status==='fulfilled').value;
    assert.equal(owner.status,'running');
    await store.updateMemoryProgress({executionId,workerId:owner.owner,epoch:owner.epoch,
      progress:{effectCount:1,status:'running'}});
    await store.cancel({executionId,userId,projectId:project});
    assert.equal((await store.get(executionId)).status,'cancelled');
    await assert.rejects(()=>store.complete({executionId,workerId:owner.owner,
      epoch:owner.epoch,result:{ok:true}}),e=>e.code==='CONFLICT');
    return backend;
  }finally{await storage.delete('nativeWorkflowExecutions/'+executionId);await storage.close();}
}

test('native memory composition uses same Firestore backend for lifecycle',{
  skip:!Boolean(tokenFile||process.env.FIRESTORE_EMULATOR_HOST),timeout:120000,
},async()=>{
  const backend=await exercise({env:{AWFL_DOCUMENT_STORAGE_BACKEND:'firestore'},firestoreDb:await makeFirestore()});
  assert.equal(backend,'firestore');
});

test('native memory composition uses same PostgreSQL backend for lifecycle',{
  skip:!Boolean(process.env.PGTEST_URL),timeout:120000,
},async()=>{
  const pool=new pg.Pool({connectionString:process.env.PGTEST_URL,max:4});
  try {
    const backend=await exercise({env:{AWFL_DOCUMENT_STORAGE_BACKEND:'postgres'},postgresPool:pool,initializeSchema:true});
    assert.equal(backend,'postgres');
  }finally{await pool.end();}
});
