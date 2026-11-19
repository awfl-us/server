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
import {createLlmRouter} from '../jobs/llm.js';

const enabled=Boolean(process.env.PGTEST_URL&&process.env.AWFL_NATIVE_LOCAL_BUILD_REPORT);
if(enabled){
 const u=new URL(process.env.PGTEST_URL);
 if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.pathname!=='/awfl_reconcile')
   throw new Error('Refusing non-isolated PostgreSQL database');
}
test('real Jobs typed 422 reaches compiled EventHandler as terminal memory-mode failure',
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
app.use('/llm',createLlmRouter({
  apiKeyForUser: async()=> 'test-key-not-sent',
  adapters:{openai:{chat:async ({tools})=>{
    invalidReplies++;
    const read=tools?.find(x=>x.function?.name==='READ_FILE');
    assert.ok(read,'Project Manager must send the READ_FILE tool schema');
    return {message:{role:'assistant',tool_calls:[{id:'bad-read',type:'function',
      function:{name:'READ_FILE',arguments:JSON.stringify({filepath:42})}}]},
      usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}};
  }}},recordUsage:async()=>{accounted++;}
}));
const server=app.listen(0,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
const url='http://127.0.0.1:'+server.address().port;
const fixture=makeReconciliationFixture({scenario:'tool-roundtrip'});
let accounted=0,invalidReplies=0;
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
    if(path==='/llm/chat' && effect.args.body?.workflow_name==='codebase-ProjectManager'){
      assert.equal(effect.args.body.validate_tool_arguments,true,
        'compiled Scala tool completion must opt in to validation');
      const response=await fetch(url+'/llm/chat',{method:'POST',
        headers:{'content-type':'application/json'},body:JSON.stringify(effect.args.body)});
      const body=await response.json();
      assert.equal(response.status,422,JSON.stringify(body));
      assert.match(body.reason,/filepath: expected string/);
      if(!response.ok) throw new NativeConfirmedHttpFailure(response.status);
      return {code:response.status,body};
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
  const id=await make('read the file');
  const result=await runNativeMemoryWorkflow({store,releases,handlers,executionId:id,...identity});
  const persisted=await store.get(id);
  assert.equal(result.status,'failed',JSON.stringify(result));
  assert.equal(persisted.status,'failed');
  assert.match(JSON.stringify(result.error),/422/);
  assert.equal(invalidReplies,1,'provider called once');
  assert.equal(accounted,1,'rejected provider completion still accounted');
  assert.deepEqual(fixture.messages().map(m=>m.value?.role),['user'],
    'invalid model tool calls must never persist as assistant/tool messages');
  const lockPath='users/'+identity.userId+'/projects/'+identity.projectId+
    '/locks.Convo.Session/'+fixture.sessionId;
  assert.equal(await storage.get(lockPath),null,'failure must release session lock');
  const replay=await runNativeMemoryWorkflow({store,releases,
    handlers:{},executionId:id,...identity});
  assert.deepEqual(replay,result,'terminal failure must not repeat provider call');
  assert.equal(accounted,1);
  console.log('TYPED_422_MEMORY_PASS',JSON.stringify({
    status:persisted.status,code:result.error?.code,
    providerCalls:invalidReplies,accounted,roles:fixture.messages().map(m=>m.value?.role)}));
  scheduler=nativeMemoryAsyncSchedulerFor({store,releases,handlers});
  await scheduler.drain({timeoutMs:5000});
} finally{
  await scheduler?.close();
  for(const doc of await storage.query({collection})) await storage.delete(doc.path);
  await storage.delete('users/'+identity.userId+'/projects/'+identity.projectId+
    '/locks.Convo.Session/'+fixture.sessionId).catch(()=>{});
  await new Promise(resolve=>server.close(resolve));
  await storage.close();await pool.end();
}
});
