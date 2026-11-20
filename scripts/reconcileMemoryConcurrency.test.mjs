import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import express from 'express';
import {PostgresStorage} from '../storage/postgres/storage.js';
import {DocumentAtomicRecords} from '../storage/document/atomicRecords.js';
import {NativeMemoryExecutionPilotStore} from '../storage/pilot/memoryExecutionState.js';
import {runNativeMemoryWorkflow,nativeMemoryAsyncSchedulerFor} from '../workflows/native/memoryWorker.js';
import {localReleases,createReplayHttpHandlers} from './nativeLocalDev.mjs';
import {makeReconciliationFixture} from './reconcileScenario.mjs';
import {createNativeStorageEffectHandler} from '../workflows/native/storageEffects.js';
import {createFirebaseDbRouter} from '../jobs/firebaseDbApi.js';
import {NativeConfirmedHttpFailure} from '../workflows/native/effectErrors.js';

const enabled=Boolean(process.env.PGTEST_URL&&process.env.AWFL_NATIVE_LOCAL_BUILD_REPORT);
if(enabled){
 const u=new URL(process.env.PGTEST_URL);
 if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.pathname!=='/awfl_reconcile')
   throw new Error('Refusing non-isolated PostgreSQL database');
}
test('two concurrent native memory-mode Project Manager turns never silently lose a user response',
  {skip:!enabled,timeout:90000},async()=>{
process.env.NODE_ENV='test';process.env.GCP_PROJECT='awfl-us';
const DB=process.env.PGTEST_URL,identity={userId:'reconcile-memory-'+randomUUID().replaceAll('-',''),projectId:'reconcile-project'};
const releases=await localReleases(process.env.AWFL_NATIVE_LOCAL_BUILD_REPORT);
const root=await releases.active('codebase-ProjectManager');
const pool=new pg.Pool({connectionString:DB,max:14});
const storage=new PostgresStorage({pool}); await storage.initialize();
const collection='reconcileMemoryConcurrent_'+randomUUID().replaceAll('-','');
const records=new DocumentAtomicRecords({storage,collection});
const store=new NativeMemoryExecutionPilotStore({records});
const app=express();app.use(express.json());app.use((req,_res,next)=>{req.userId=identity.userId;req.projectId=identity.projectId;next();});
app.use('/firebase',createFirebaseDbRouter({getStorage:async()=>storage}));
const server=app.listen(0,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
const url='http://127.0.0.1:'+server.address().port;
const fixture=makeReconciliationFixture({scenario:'basic'});
let onFirstModel;const firstModel=new Promise(resolve=>onFirstModel=resolve);
let releaseFirstModel;const firstAllowed=new Promise(resolve=>releaseFirstModel=resolve);
let foregroundCalls=0;
const seen=[],missing=[];
const raw=createReplayHttpHandlers({identity,fixtures:{},seen,missing,respond:fixture.respond});
const handlers={...raw};
for(const op of ['http.get','http.post','http.patch','http.delete']){
  handlers[op]=async function(effect){
    const path=new URL(effect.args.url).pathname;
    if(path.startsWith('/firebase/locks/')){
      const response=await fetch(url+path,{method:op==='http.get'?'GET':'POST',
        headers:{'content-type':'application/json'},body:JSON.stringify(effect.args.body)});
      const content=await response.json();
      if(!response.ok) throw new NativeConfirmedHttpFailure(response.status);
      return {code:response.status,body:content};
    }
    if(path==='/llm/chat' && ['codebase-ProjectManager','helpers-Convo'].includes(effect.args.body?.workflow_name) && !effect.args.body?.tool_choice?.function?.name){
      foregroundCalls++;
      if(foregroundCalls===1){onFirstModel();await firstAllowed;}
    }
    return raw[op](effect);
  };
}
const mockFile=Buffer.from('#!/bin/sh\n# Reconciliation test fixture, not executable\necho harmless\n');
handlers['storage.object_get']=createNativeStorageEffectHandler({storage:{bucket:name=>({file:key=>({getMetadata:async()=>[{size:mockFile.length}],download:async()=>[mockFile]})})}});
handlers['callback.create']=fixture.callbackCreate;
handlers['callback.await']=fixture.callbackAwait;
handlers['log.write']=async()=>null;
const ids=[];
async function make(query){
  const id='native_'+randomUUID().replaceAll('-','');ids.push(id);
  const input={fund:2,query,env:{...identity,sessionId:fixture.sessionId,model:'gpt-6.1-terra',
    BASE_URL:'https://jobs-4wmfqir74q-uc.a.run.app',background:false,workdir:'/tmp/reconcile-sandbox'}};
  await store.create({executionId:id,...identity,workflowName:'codebase-ProjectManager',artifactSha256:root.sha256,
    protocolVersion:2,allowedOperations:[...root.allowedOperations],parallelVersion:root.parallelVersion,
    streamIpcVersion:root.streamIpcVersion,trustedGlobalsVersion:root.trustedGlobalsVersion,input});
  return id;
}
let scheduler;
try{
  const first=await make('first turn');
  const second=await make('second turn');
  const run=id=>runNativeMemoryWorkflow({store,releases,handlers,executionId:id,...identity});
  const a=run(first);
  await Promise.race([firstModel,new Promise((_,reject)=>setTimeout(()=>reject(Error('first model call not reached')),9000))]);
  const b=await run(second);
  releaseFirstModel();
  const av=await a;
  assert.equal((await store.get(first)).status,'completed');
  assert.equal((await store.get(second)).status,'failed',
    'busy request must have a retriable failed status, not silent completion');
  assert.equal(b.status,'failed');
  assert.match(JSON.stringify(b.error),/Session is busy|409/);
  assert.equal(foregroundCalls,1,'busy request must not call the model');
  assert.deepEqual(fixture.messages().map(m=>m.value?.role),['user','assistant']);
  assert.deepEqual(fixture.messages().filter(m=>m.value?.role==='user').map(m=>m.value?.content),
    ['first turn'],'busy request must not persist an unanswered user turn');
  const retry=await make('second turn');
  const retried=await run(retry);
  assert.equal((await store.get(retry)).status,'completed',
    'new execution for a rejected busy turn must complete once lock is released');
  assert.notEqual(retried?.status,'failed');
  assert.equal(foregroundCalls,2,'retry must invoke the model exactly once');
  assert.deepEqual(fixture.messages().map(m=>m.value?.role),
    ['user','assistant','user','assistant']);
  assert.deepEqual(fixture.messages().filter(m=>m.value?.role==='user').map(m=>m.value?.content),
    ['first turn','second turn'],'each accepted user turn must be stored once');
  const statusFor=id=>fixture.requests.filter(req=>
    req.path==='/workflows/exec/status/update'&&req.body.execId===id);
  for(const [id,expected] of [
    [first,['Running','Done']],
    [second,['Running','Failed']],
    [retry,['Running','Done']]
  ]){
    const transitions=statusFor(id);
    assert.deepEqual(transitions.map(x=>x.body.status),expected,
      `Status trait must record ${expected.join(' → ')} for ${id}`);
    assert.deepEqual(transitions.map(x=>x.body.ended),[false,true],
      'only terminal lifecycle event should set ended=true');
  }
  assert.match(String(statusFor(second).at(-1)?.body.error),/Session is busy|409/);
  console.log('STATUS_LIFECYCLE_PARITY_PASS',JSON.stringify({
    first:statusFor(first).map(x=>x.body.status),
    busy:statusFor(second).map(x=>x.body.status),
    retry:statusFor(retry).map(x=>x.body.status)
  }));
  console.log('CONCURRENT_MEMORY_RESULT',JSON.stringify({firstStatus:(await store.get(first)).status,secondStatus:(await store.get(second)).status,
     a:av?.status||'completed',b:b?.status||'completed',bError:b?.error,
     foregroundCalls,roles:fixture.messages().map(m=>m.value?.role),users:fixture.messages().filter(m=>m.value?.role==='user').map(m=>m.value?.content),
     missing:missing.slice(0,3)}));
  scheduler=nativeMemoryAsyncSchedulerFor({store,releases,handlers});
  await scheduler.drain({timeoutMs:7000});
} finally {
  releaseFirstModel();
  await scheduler?.close();
  for(const doc of await storage.query({collection}))await storage.delete(doc.path);
  await storage.delete('users/'+identity.userId+'/projects/'+identity.projectId+'/locks.Convo.Session/'+fixture.sessionId).catch(()=>{});
  await new Promise(resolve=>server.close(resolve)); await storage.close();await pool.end();
}

});
