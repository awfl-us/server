/** Original wip-old Strider's Sadhaka delegation in compiled Rust memory mode. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PostgresStorage} from '../storage/postgres/storage.js';
import {DocumentAtomicRecords} from '../storage/document/atomicRecords.js';
import {NativeMemoryExecutionPilotStore} from '../storage/pilot/memoryExecutionState.js';
import {runNativeMemoryWorkflow} from '../workflows/native/memoryWorker.js';
import {localReleases,createReplayHttpHandlers} from './nativeLocalDev.mjs';
import {makeReconciliationFixture} from './reconcileScenario.mjs';
import {createNativeStorageEffectHandler} from '../workflows/native/storageEffects.js';

const DB=process.env.PGTEST_URL;
const REPORT=process.env.AWFL_STRIDER_NATIVE_REPORT;
const enabled=Boolean(DB && REPORT);
if(enabled){const u=new URL(DB);if(!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||u.pathname!=='/awfl_reconcile')throw Error('isolated Postgres only');}

for (const {workflow,outputTool,collectionPattern,count=1} of [
  {workflow:'Summaries-Convo',outputTool:'summaries',collectionPattern:/summar/i},
  {workflow:'assistant-ExtractTopics-Convo',outputTool:'topicInfos',collectionPattern:/topic/i},
  {workflow:'context-ContextCollapser-SegKala',outputTool:'collapsed',collectionPattern:/collaps/i},
  {workflow:'Summaries-All',outputTool:'summaries',collectionPattern:/summar/i,count:4},
  {workflow:'Summaries-Backfill',outputTool:'summaries',collectionPattern:/summar/i,count:4},
  {workflow:'Summaries',outputTool:'summaries',collectionPattern:/summar/i,count:4},
  {workflow:'assistant-ExtractTopics-All',outputTool:'topicInfos',collectionPattern:/topic/i,count:4},
  {workflow:'assistant-ExtractTopics-Backfill',outputTool:'topicInfos',collectionPattern:/topic/i,count:4},
  {workflow:'assistant-ExtractTopics',outputTool:'topicInfos',collectionPattern:/topic/i,count:4},
]) test('compiled '+workflow+' invokes native typed Sadhaka and persists one result',
{skip:!enabled,timeout:90000},async()=>{
  process.env.NODE_ENV='test';process.env.GCP_PROJECT||='awfl-us';
  const pool=new pg.Pool({connectionString:DB,max:5});
  const storage=new PostgresStorage({pool});await storage.initialize();
  const records=new DocumentAtomicRecords({storage,collection:'reconcileStrider_'+randomUUID().replaceAll('-','')});
  const store=new NativeMemoryExecutionPilotStore({records});
  const releases=await localReleases(REPORT);
  const root=await releases.active(workflow);
  assert.ok(root,'compiled '+workflow+' required');
  const executionId='native_'+randomUUID().replaceAll('-','');
  const identity={userId:'strider-'+randomUUID().replaceAll('-',''),projectId:'reconcile-project'};
  const fixture=makeReconciliationFixture({scenario:'no-query',sessionId:'reconcile-session'});
  const input={agentId:'codebase-ProjectManager',segmentEnd:Date.now()/1000,windowSeconds:1200,overlapSeconds:60,
    env:{...identity,sessionId:'reconcile-session',model:'gpt-6.1-terra',
      BASE_URL:'https://jobs-4wmfqir74q-uc.a.run.app',background:false,workdir:'/tmp/reconcile-sandbox'}};
  await store.create({executionId,...identity,workflowName:root.workflowName,
    artifactSha256:root.sha256,protocolVersion:2,allowedOperations:[...root.allowedOperations],
    parallelVersion:root.parallelVersion,streamIpcVersion:root.streamIpcVersion,
    trustedGlobalsVersion:root.trustedGlobalsVersion,input});
  const seen=[],missing=[];
  const persistedOutputs=[];
  const isDirectSegment=count===1;
  const respond=effect=>{
    const {method,path,args}=effect;
    const col=String(args?.body?.collection||'');
    if(isDirectSegment && method==='POST' && path==='/firebase/list'
       && collectionPattern.test(col)) {
      return {code:200,body:{documents:persistedOutputs.map((data,i)=>({
        id:'prior-'+i,data,subcollections:[]}))}};
    }
    const result=fixture.respond(effect);
    if(isDirectSegment && method==='POST' && path==='/firebase/create'
       && collectionPattern.test(col)) persistedOutputs.push(args.body.contents);
    return result;
  };
  const handlers=createReplayHttpHandlers({identity,fixtures:{},seen,missing,
    respond});
  handlers['callback.create']=fixture.callbackCreate;
  handlers['callback.await']=fixture.callbackAwait;
  handlers['log.write']=async()=>null;
  const script=Buffer.from('echo harmless\n');
  handlers['storage.object_get']=createNativeStorageEffectHandler({storage:{
    bucket:()=>({file:()=>({getMetadata:async()=>[{size:script.length}],
      download:async()=>[script]})})}});
  try{
    const result=await runNativeMemoryWorkflow({store,releases,handlers,
      executionId,...identity});
    assert.equal((await store.get(executionId)).status,'completed',JSON.stringify(result));
    assert.deepEqual(missing,[]);
    const typed=fixture.modelRequests.filter(x=>x.tool_choice?.function?.name===outputTool);
    assert.equal(typed.length,count,'expected typed Sadhaka model calls');
    const writes=fixture.requests.filter(x=>x.path==='/firebase/create'
      && collectionPattern.test(x.body.collection||''));
    const updates=fixture.requests.filter(x=>x.path==='/firebase/update' &&
      collectionPattern.test(x.body.collection||''));
    assert.equal(writes.length,1,'one SegKala child is created');
    assert.equal(updates.length,count-1,'remaining calendar levels update their own stored output');
    if(isDirectSegment) {
      const repeatId='native_'+randomUUID().replaceAll('-','');
      await store.create({executionId:repeatId,...identity,workflowName:root.workflowName,
        artifactSha256:root.sha256,protocolVersion:2,allowedOperations:[...root.allowedOperations],
        parallelVersion:root.parallelVersion,streamIpcVersion:root.streamIpcVersion,
        trustedGlobalsVersion:root.trustedGlobalsVersion,input});
      const replay=await runNativeMemoryWorkflow({store,releases,handlers,
        executionId:repeatId,...identity});
      assert.equal((await store.get(repeatId)).status,'completed',JSON.stringify(replay));
      assert.equal(fixture.modelRequests.filter(x=>x.tool_choice?.function?.name===outputTool).length,1,
        'existing segment output must suppress duplicate model completion');
      assert.equal(fixture.requests.filter(x=>x.path==='/firebase/create'
        && collectionPattern.test(x.body.collection||'')).length,1,
        'existing segment output must suppress duplicate writes');
    }
    console.log('STRIDER_NATIVE_PASS',JSON.stringify({root:root.workflowName,
      typedCalls:typed.length,writes:writes.map(x=>x.body.collection),updates:updates.map(x=>x.body.collection),result}));
  }finally{await pool.end();}
});
