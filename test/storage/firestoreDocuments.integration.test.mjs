import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Firestore} from '@google-cloud/firestore';
import {GoogleAuth,OAuth2Client} from 'google-auth-library';
import {FirestoreStorage} from '../../storage/firestore/storage.js';
import {patch} from '../../storage/document/contract.js';

const tokenFile=process.env.GOOGLE_ACCESS_TOKEN_FILE || process.env.CLOUDSDK_AUTH_ACCESS_TOKEN_FILE;
const enabled=Boolean(tokenFile || process.env.FIRESTORE_EMULATOR_HOST);
let sharedDb;
after(async()=>{ if(sharedDb) await sharedDb.terminate(); });
async function db() {
  if (sharedDb) return sharedDb;
  if (process.env.FIRESTORE_EMULATOR_HOST) return sharedDb=new Firestore({projectId:'demo-awfl-storage-test'});
  const token=(await readFile(tokenFile,'utf8')).trim();
  if (!token) throw new Error('empty test OAuth token');
  const oauth=new OAuth2Client();
  oauth.setCredentials({access_token:token,expiry_date:Date.now()+20*60_000});
  const auth=new GoogleAuth({projectId:'awfl-us'});
  auth.getClient=async()=>oauth;
  return sharedDb=new Firestore({projectId:'awfl-us',auth});
}
async function setup() {
  const database=await db();
  const storage=new FirestoreStorage({db:database});
  const root='storageAdapterTests/'+randomUUID().replaceAll('-','');
  const collection=root+'/cases';
  const paths=[];
  const ref=id=>{const path=collection+'/'+id;paths.push(path);return path;};
  return {storage,collection,ref,clean:async()=>{
    for (const path of [...new Set(paths)]) await storage.delete(path);
    await storage.close();
  }};
}

test('Firestore real: CRUD, revisions, scoped queries, batch and rollback', {skip:!enabled,timeout:100_000},async()=>{
  const {storage,collection,ref,clean}=await setup();
  const one=ref('one'),two=ref('two'),three=ref('three'),four=ref('four');
  try {
    assert.equal(await storage.get(one),null);
    await storage.create(one,{status:'new',price:10, details:{visits:0}});
    await assert.rejects(()=>storage.create(one,{}),x=>x.code==='ALREADY_EXISTS');
    assert.deepEqual((await storage.get(one)).data,{status:'new',price:10,details:{visits:0}});
    await storage.update(one,{'details.visits':patch.increment(3),status:'done'});
    assert.equal((await storage.get(one)).revision,2);
    await storage.batch([{op:'create',path:two,data:{status:'new',price:20}},
      {op:'put',path:three,data:{status:'pending',price:30}}]);
    assert.equal(await storage.count({collection,where:[{field:'status',op:'==',value:'new'}]}),1);
    assert.deepEqual((await storage.query({collection,where:[{field:'status',op:'==',value:'new'}]})).map(x=>x.id),['two']);
    assert.deepEqual((await storage.query({collection,limit:2})).map(x=>x.id),['one','three']);
    assert.deepEqual((await storage.query({collection,startAfter:three})).map(x=>x.id),['two']);
    assert.deepEqual(await storage.listCollections(collection.split('/').slice(0,-1).join('/')),['cases']);
    await assert.rejects(()=>storage.batch([{op:'create',path:four,data:{}},{op:'create',path:one,data:{}}]),x=>x.code==='ALREADY_EXISTS');
    assert.equal(await storage.get(four),null);
    await storage.delete(two);
    assert.equal(await storage.get(two),null);
  }finally{await clean();}
});

test('Firestore real: concurrent increments, memory worker fencing', {skip:!enabled,timeout:120_000},async()=>{
  const {storage,collection,ref,clean}=await setup();
  const path=ref('counter');
  try {
    await storage.create(path,{count:0});
    await Promise.all(Array.from({length:8},()=>storage.update(path,{count:patch.increment(1)})));
    assert.equal((await storage.get(path)).data.count,8);
    const {DocumentAtomicRecords}=await import('../../storage/document/atomicRecords.js');
    const {NativeMemoryExecutionPilotStore}=await import('../../storage/pilot/memoryExecutionState.js');
    const records=new DocumentAtomicRecords({storage,collection});
    const state=new NativeMemoryExecutionPilotStore({records});
    const executionId=ref('native_'+randomUUID().replaceAll('-','')).split('/').at(-1);
    await state.create({executionId,userId:'u',projectId:'p',workflowName:'Test',artifactSha256:'a'.repeat(64),input:{x:1},allowedOperations:[]});
    const claims=await Promise.allSettled(Array.from({length:6},(_,i)=>state.claim({executionId,workerId:'w'+i,expectedUserId:'u',expectedProjectId:'p',leaseMs:60000})));
    assert.equal(claims.filter(x=>x.status==='fulfilled').length,1);
    const value=claims.find(x=>x.status==='fulfilled').value;
    await state.complete({executionId,workerId:value.owner,epoch:value.epoch,result:{ok:true}});
    assert.equal((await state.get(executionId)).status,'completed');
  }finally{await clean();}
});

test('Firestore real: snapshot and event watcher', {skip:!enabled,timeout:90000},async()=>{
  const {storage,ref,clean}=await setup();
  const path=ref('watched');
  const events=[];
  let unsubscribe;
  try {
    unsubscribe=await storage.subscribe(path,x=>events.push(x));
    assert.equal(events[0]?.type,'snapshot');
    await storage.create(path,{status:'ready'});
    await storage.update(path,{status:'done'});
    await storage.delete(path);
    const deadline=Date.now()+20000;
    while (events.filter(x=>x.type==='change').length<3 && Date.now()<deadline) await new Promise(r=>setTimeout(r,100));
    assert.deepEqual(events.filter(x=>x.type==='change').map(x=>x.value?.data?.status),['ready','done',undefined]);
    await assert.rejects(()=>storage.subscribe(path,()=>{},{afterCursor:'1'}),x=>x.code==='UNSUPPORTED');
  }finally{await unsubscribe?.();await clean();}
});
