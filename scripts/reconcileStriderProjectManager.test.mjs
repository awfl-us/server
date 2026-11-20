/** Local Strider -> native ProjectManager -> Jobs LLM -> persisted summary.
 *
 * Default: deterministic model adapter, real Jobs HTTP routers and isolated
 * Postgres. Opt in to a real model with AWFL_STRIDER_PROVIDER=live and an
 * explicitly supplied AWFL_STRIDER_OPENAI_API_KEY (or OPENAI_API_KEY).
 * Nothing is deployed or sent to production.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import express from 'express';
import {PostgresStorage} from '../storage/postgres/storage.js';
import {DocumentAtomicRecords} from '../storage/document/atomicRecords.js';
import {NativeMemoryExecutionPilotStore} from '../storage/pilot/memoryExecutionState.js';
import {runNativeMemoryWorkflow,nativeMemoryAsyncSchedulerFor} from '../workflows/native/memoryWorker.js';
import {localReleases,createReplayHttpHandlers} from './nativeLocalDev.mjs';
import {makeReconciliationFixture} from './reconcileScenario.mjs';
import {createNativeStorageEffectHandler} from '../workflows/native/storageEffects.js';
import {createNativeLogEffectHandler} from '../workflows/native/logEffects.js';
import {createFirebaseDbRouter} from '../jobs/firebaseDbApi.js';
import {createLlmRouter} from '../jobs/llm.js';
import realOpenaiAdapter from '../jobs/providers/openai.js';
import {projectScopedCollectionPath} from '../workflows/utils.js';
import {NativeConfirmedHttpFailure} from '../workflows/native/effectErrors.js';

const DB=process.env.PGTEST_URL;
const REPORT=process.env.AWFL_STRIDER_NATIVE_REPORT;
const LIVE=process.env.AWFL_STRIDER_PROVIDER==='live';
const KEY=process.env.AWFL_STRIDER_OPENAI_API_KEY||process.env.OPENAI_API_KEY;
const MODEL=process.env.AWFL_STRIDER_MODEL || (LIVE?'gpt-4.1-mini':'gpt-6.1-terra');
const CONVERSATION_FILE=process.env.AWFL_STRIDER_CONVERSATION_FILE ||
  new URL('./fixtures/strider-summary-conversation.json',import.meta.url);
const enabled=Boolean(DB&&REPORT);
if(enabled){
  const url=new URL(DB);
  if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.pathname!=='/awfl_reconcile')
    throw Error('Only isolated loopback /awfl_reconcile is allowed');
}
if(LIVE&&!KEY)throw Error('Live mode requires AWFL_STRIDER_OPENAI_API_KEY or OPENAI_API_KEY');
if(!['live',undefined].includes(process.env.AWFL_STRIDER_PROVIDER))
  throw Error('AWFL_STRIDER_PROVIDER must be unset or live');

for(const scenario of ['sequential','contended','provider-failure','callback-failure'])
test('Strider → native ProjectManager → Postgres summary: '+scenario,
  {skip:!enabled||(LIVE&&scenario!=='sequential'),timeout:120000},async()=>{
  process.env.NODE_ENV='test';
  process.env.GCP_PROJECT||='awfl-us';
  const identity={userId:'strider-pm-'+randomUUID().replaceAll('-',''),projectId:'local-pm-test'};
  const sessionId='reconcile-session', collection='reconcileStriderPm_'+randomUUID().replaceAll('-','');
  const pool=new pg.Pool({connectionString:DB,max:10});
  const storage=new PostgresStorage({pool});
  await storage.initialize();
  const records=new DocumentAtomicRecords({storage,collection});
  const store=new NativeMemoryExecutionPilotStore({records});
  const releases=await localReleases(REPORT);
  const root=await releases.active('Summaries-Convo');
  assert.ok(root,'compile the native 27-workflow ProjectManager closure first');
  assert.ok(await releases.active('codebase-ProjectManager'));
  assert.ok(await releases.active('helpers-Convo'));
  const scope=name=>projectScopedCollectionPath(identity.userId,identity.projectId,name);
  const messagesCollection=scope(`convo.sessions/${sessionId}/messages`);
  const summariesCollection=scope(`convo.sessions/${sessionId}/summaries`);
  const now=Date.now()/1000,segmentEnd=now+5;
  const turns=JSON.parse(await readFile(CONVERSATION_FILE,'utf8'));
  assert.ok(Array.isArray(turns)&&turns.length>=1&&turns.length<=24,
    'conversation JSON must be an array of 1–24 messages');
  assert.ok(turns.some(t=>t.role==='user'),'at least one user message is required');
  assert.ok(turns.every(t=>['user','assistant'].includes(t.role)&&
    typeof t.content==='string'&&t.content.length>0&&t.content.length<4000),
  'each turn needs role user/assistant and nonempty text under 4000 characters');
  const fixture=makeReconciliationFixture({scenario:'no-query',sessionId});
  // Replace the fixture's default prior turn with this actual test conversation.
  fixture.docs.clear();
  for(let i=0;i<turns.length;i++){
    const timestamp=now-10-(turns.length-i)*5;
    const data={create_time:timestamp,value:{...turns[i],create_time:timestamp,tool_calls:[]}};
    await storage.create(messagesCollection+'/turn-'+i,data);
    fixture.docs.set(`convo.sessions/${sessionId}/messages/turn-${i}`,data);
  }

  const seen=[],missing=[],modelRequests=[],modelWorkflows=[],lockEvents=[];
  let usageWrites=0,callbackCreates=0,callbackAwaits=0;
  const createdCallbackUrls=new Set(),awaitedCallbackUrls=new Set();
  let failProvider=scenario==='provider-failure';
  let failCallback=scenario==='callback-failure';
  // Hold the first completed model request until the competing workflow
  // observes the *real* Postgres owner-scoped lock. No timing sleeps or fake
  // locks: both compiled native workflows execute concurrently.
  let notifyModelStarted,releaseModel;
  const modelStarted=new Promise(resolve=>{notifyModelStarted=resolve;});
  const modelRelease=new Promise(resolve=>{releaseModel=resolve;});
  const adapter=LIVE?realOpenaiAdapter:{chat:async ({messages,tool_choice,tools})=>{
    if(failProvider){failProvider=false;throw new Error('injected provider outage');}
    if(scenario==='contended'){
      notifyModelStarted();
      await modelRelease;
    }
    const name=tool_choice?.function?.name;
    assert.equal(name,'summaries','Sadhaka must explicitly choose the summary output function');
    const outputTools=tools.filter(t=>t.function?.name===name);
    assert.equal(outputTools.length,1,'strict typed output function is advertised exactly once');
    assert.equal(outputTools[0].function.parameters.type,'object');
    assert.equal(outputTools[0].function.parameters.additionalProperties,false);
    assert.ok(tools.every(t=>!('workflowName' in t)),'workflow routing metadata stays private');
    const context=messages.map(m=>String(m.content||'')).join(' ');
    const userTurns=turns.filter(t=>t.role==='user');
    assert.ok(userTurns.every(t=>context.includes(t.content)),
      'PM must receive every seeded user turn, not a synthetic fallback');
    // Derive the output from the real model input instead of returning a
    // fixed canned fixture independent of the user's conversation.
    const statements=userTurns.map(t=>t.content);
    const value={title:'AWFL '+(statements[0].match(/memory mode/i)?'Memory Mode':'Conversation'),
      summary:statements.join(' ')};
    return {message:{role:'assistant',content:'',tool_calls:[{id:'strider-pm-summary-'+randomUUID(),
      type:'function',function:{name,arguments:JSON.stringify(value)}}]},
      usage:{prompt_tokens:100,completion_tokens:35,total_tokens:135}};
  }};

  const app=express();app.use(express.json({limit:'2mb'}));
  app.use((req,_res,next)=>{req.userId=identity.userId;req.projectId=identity.projectId;next();});
  app.use('/firebase',createFirebaseDbRouter({getStorage:async()=>storage}));
  app.use('/llm',createLlmRouter({
    apiKeyForUser:async()=>LIVE?KEY:'local-deterministic-provider',
    recordUsage:async()=>{usageWrites++;},
    adapters:{openai:{chat:async params=>{
      modelRequests.push({messages:params.messages,tool_choice:params.tool_choice,
        tools:params.tools,model:params.model});
      const response=await adapter.chat(params);
      return response;
    }}}
  }));
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const respond=fixture.respond;
  const raw=createReplayHttpHandlers({identity,fixtures:{},seen,missing,respond});
  const handlers={...raw};
  for(const [operation,method] of Object.entries({'http.get':'GET','http.post':'POST',
      'http.patch':'PATCH','http.delete':'DELETE'})){
    handlers[operation]=async effect=>{
      const url=new URL(effect.args.url);
      if(url.pathname.startsWith('/firebase/')||url.pathname==='/llm/chat'){
        seen.push({op:operation,path:url.pathname});
        if(url.pathname==='/llm/chat'){
          assert.equal(effect.args.body?.validate_tool_arguments,true,
            'ProjectManager typed Sadhaka requests must validate output schema');
          modelWorkflows.push(effect.args.body?.workflow_name);
        }
        const response=await fetch(origin+url.pathname,{method,headers:{'content-type':'application/json'},
          body:method==='GET'?undefined:JSON.stringify(effect.args.body)});
        const content=await response.json();
        if(url.pathname.startsWith('/firebase/locks/'))
          lockEvents.push({path:url.pathname,status:response.status,response:content,
            owner:effect.args.body?.owner,id:effect.args.body?.id});
        if(!response.ok)throw new NativeConfirmedHttpFailure(response.status);
        return {code:response.status,body:content};
      }
      return raw[operation](effect);
    };
  }
  handlers['callback.create']=async (...args)=>{
    callbackCreates++;
    const result=await fixture.callbackCreate(...args);
    createdCallbackUrls.add(result.url);
    return result;
  };
  handlers['callback.await']=async (...args)=>{
    callbackAwaits++;
    const url=args[0]?.args?.callback?.url;
    if(url)awaitedCallbackUrls.add(url);
    if(failCallback&&modelRequests.length>0){
      failCallback=false;
      throw new Error('injected callback transport failure after model response');
    }
    return fixture.callbackAwait(...args);
  };
  // Never bypass the native authenticated logging size/identity checks.
  const logs=[];
  handlers['log.write']=createNativeLogEffectHandler({info:entry=>logs.push(entry)});
  const mockFile=Buffer.from('echo harmless\n');
  handlers['storage.object_get']=createNativeStorageEffectHandler({storage:{
    bucket:()=>({file:()=>({getMetadata:async()=>[{size:mockFile.length}],
      download:async()=>[mockFile]})})}});
  const input={agentId:'codebase-ProjectManager',segmentEnd,windowSeconds:1200,
    overlapSeconds:60,env:{...identity,sessionId,model:MODEL,
      BASE_URL:'https://jobs-4wmfqir74q-uc.a.run.app',background:false,
      workdir:'/tmp/reconcile-sandbox'}};
  const createExecution=async(targetStore=store)=>{
    const executionId='native_'+randomUUID().replaceAll('-','');
    await targetStore.create({executionId,...identity,workflowName:root.workflowName,
      artifactSha256:root.sha256,protocolVersion:2,
      allowedOperations:[...root.allowedOperations],
      parallelVersion:root.parallelVersion,streamIpcVersion:root.streamIpcVersion,
      trustedGlobalsVersion:root.trustedGlobalsVersion,input});
    return executionId;
  };
  let scheduler,initialRun,competingPool,competingStorage;
  const assertNoLockLeak=async()=>{
    assert.equal((await storage.query({collection:scope('locks.summaries.SegKala')})).length,0,
      'all segment locks must be deleted after terminal native execution');
    const grants=lockEvents.filter(e=>e.path==='/firebase/locks/acquire'&&e.status===200);
    const releases=lockEvents.filter(e=>e.path==='/firebase/locks/release'&&e.status===200);
    assert.deepEqual(releases.map(x=>x.owner).sort(),grants.map(x=>x.owner).sort(),
      'every granted lock must be released by the identical materialized owner');
  };
  try{
    const executionId=await createExecution();
    initialRun=runNativeMemoryWorkflow({store,releases,handlers,
      executionId,...identity});
    if(scenario==='contended'){
      await modelStarted;
      // A second native worker uses its own execution-store instance and
      // independent PostgreSQL connection pool, not the first worker's store.
      competingPool=new pg.Pool({connectionString:DB,max:2});
      competingStorage=new PostgresStorage({pool:competingPool});
      await competingStorage.initialize();
      const competingStore=new NativeMemoryExecutionPilotStore({records:
        new DocumentAtomicRecords({storage:competingStorage,collection})});
      const competingId=await createExecution(competingStore);
      const competing=await runNativeMemoryWorkflow({store:competingStore,releases,handlers,
        executionId:competingId,...identity});
      assert.equal((await competingStore.get(competingId)).status,'completed',JSON.stringify(competing));
      const attempts=lockEvents.filter(e=>e.path==='/firebase/locks/acquire');
      assert.equal(attempts.length,2,JSON.stringify(lockEvents));
      assert.equal(attempts.filter(e=>e.status===409).length,1,
        'only one concurrent Strider may hold the real Postgres lock');
      assert.equal(modelRequests.length,1,'the loser must never invoke ProjectManager');
      assert.equal((await storage.query({collection:summariesCollection})).length,0,
        'the winning model is held before a summary may be persisted');
      releaseModel();
    }
    const result=await initialRun;
    if(scenario==='provider-failure'||scenario==='callback-failure'){
      assert.equal((await store.get(executionId)).status,'failed',JSON.stringify(result));
      assert.equal((await storage.query({collection:summariesCollection})).length,0,
        'failed model or callback must never commit an incomplete summary');
      assert.equal(lockEvents.filter(e=>e.path==='/firebase/locks/acquire').length,1);
      assert.deepEqual(lockEvents.filter(e=>e.path==='/firebase/locks/release')
        .map(e=>({status:e.status,released:e.response.released})),
        [{status:200,released:true}],
        'failure must release precisely the same owner-scoped lock');
      const retryId=await createExecution();
      const retry=await runNativeMemoryWorkflow({store,releases,handlers,
        executionId:retryId,...identity});
      assert.equal((await store.get(retryId)).status,'completed',JSON.stringify(retry));
      assert.equal((await storage.query({collection:summariesCollection})).length,1,
        'retry after failure must create exactly one summary');
      assert.equal(modelRequests.length,2,
        'failed attempt and successful retry must each reach the Jobs LLM router');
      assert.ok(awaitedCallbackUrls.size>0,'the native callback-await path must actually run');
      assert.ok([...awaitedCallbackUrls].every(url=>createdCallbackUrls.has(url)),
        'all callback waits must refer to a callback created by this run');
      if(scenario==='callback-failure')
        assert.equal(modelRequests.length,2,
          'callback failure must occur after the first typed model response, before retry');
      assert.equal(lockEvents.filter(e=>e.path==='/firebase/locks/acquire').length,2);
      assert.ok(lockEvents.filter(e=>e.path==='/firebase/locks/acquire')
        .every(e=>e.status===200&&e.response.acquired===true));
      assert.ok(lockEvents.filter(e=>e.path==='/firebase/locks/release')
        .every(e=>e.status===200&&e.response.released===true));
      await assertNoLockLeak();
      assert.deepEqual(missing,[]);
      console.log('STRIDER_RETRY_LOCAL_PASS',JSON.stringify({scenario,
        modelCalls:modelRequests.length,callbackCreates,callbackAwaits,
        locks:lockEvents.length,logs:logs.length}));
      return;
    }
    assert.equal((await store.get(executionId)).status,'completed',JSON.stringify(result));
    assert.deepEqual(missing,[]);
    assert.equal(modelRequests.length,1,'native Strider must call ProjectManager exactly once');
    assert.ok(modelWorkflows.every(w=>['codebase-ProjectManager','helpers-Convo'].includes(w)),
      'typed completion must go through native ProjectManager / Convo');
    assert.ok(callbackCreates>=1,'native Sadhaka must create and await a typed callback');
    assert.ok(awaitedCallbackUrls.size>0&&[...awaitedCallbackUrls]
      .every(url=>createdCallbackUrls.has(url)),'every callback wait must have a matching create');
    assert.equal(usageWrites,1);
    const rows=await storage.query({collection:summariesCollection});
    assert.equal(rows.length,1,'the generated summary must be persisted by the actual Jobs DB route');
    const summary=rows[0].data?.value;
    assert.ok(summary?.title&&summary?.summary,'typed summary must have title and summary');
    if(!LIVE){
      assert.ok(turns.filter(t=>t.role==='user').every(t=>summary.summary.includes(t.content)),
        'deterministic generated summary must reflect the supplied conversation');
    }
    const replayId=await createExecution();
    await runNativeMemoryWorkflow({store,releases,handlers,executionId:replayId,...identity});
    assert.equal((await store.get(replayId)).status,'completed');
    assert.equal(modelRequests.length,1,'same segment should not require a second PM/model call');
    assert.equal((await storage.query({collection:summariesCollection})).length,1);
    assert.equal(seen.filter(x=>x.path==='/firebase/locks/acquire').length,scenario==='contended'?3:2,
      JSON.stringify(lockEvents));
    assert.equal(seen.filter(x=>x.path==='/firebase/locks/release').length,2,
      JSON.stringify(lockEvents));
    assert.ok(lockEvents.filter(e=>e.path==='/firebase/locks/acquire')
      .filter(e=>e.status===200).every(e=>e.response.acquired===true),
      'every granted owner must really acquire its lock');
    assert.equal(lockEvents.filter(e=>e.path==='/firebase/locks/acquire'&&e.status===409).length,
      scenario==='contended'?1:0,'the contended loser must receive one 409');
    assert.ok(lockEvents.filter(e=>e.path==='/firebase/locks/release')
      .every(e=>e.status===200&&e.response.released===true),
      'both native Strider executions must actually delete their lock');
    await assertNoLockLeak();
    scheduler=nativeMemoryAsyncSchedulerFor({store,releases,handlers});
    await scheduler.drain({timeoutMs:12000});
    console.log('STRIDER_PROJECT_MANAGER_LOCAL_PASS',JSON.stringify({
      mode:LIVE?'live':'deterministic',model:MODEL,root:root.workflowName,
      modelCalls:modelRequests.length,summary,records:rows.length,callbackCreates,
      viaJobsLlm:true,viaJobsPostgres:true,duplicateCalls:0,scenario,
      contention409s:lockEvents.filter(e=>e.path==='/firebase/locks/acquire'&&e.status===409).length}));
  }finally{
    releaseModel();
    await initialRun?.catch(()=>{});
    await scheduler?.close();
    await new Promise(resolve=>server.close(resolve));
    for(const doc of await storage.query({collection}))await storage.delete(doc.path);
    for(const name of [messagesCollection,summariesCollection,
        scope('locks.summaries.SegKala'),scope('locks.Convo.Session')]){
      for(const doc of await storage.query({collection:name}))await storage.delete(doc.path);
    }
    await storage.delete(scope(`convo.sessions/${sessionId}`)).catch(()=>{});
    await competingStorage?.close();await competingPool?.end();
    await storage.close();await pool.end();
  }
});
