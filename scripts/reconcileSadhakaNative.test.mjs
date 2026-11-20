/** Compiled Sadhaka fixture, real PostgreSQL native-memory worker and effect boundary.
 * No live providers, GCP, or publishing. */
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
import express from 'express';
import {createLlmRouter} from '../jobs/llm.js';

const DB=process.env.PGTEST_URL;
const REPORT=process.env.AWFL_SADHAKA_NATIVE_REPORT;
const TARGET=process.env.AWFL_SADHAKA_TARGET || 'helpers-SadhakaChildFixture';
const CASE=process.env.AWFL_SADHAKA_CASE || 'success';
const enabled=Boolean(DB && REPORT);
if (enabled) {
  const u=new URL(DB);
  if (!['127.0.0.1','localhost','[::1]'].includes(u.hostname) ||
      u.pathname!=='/awfl_reconcile')
    throw new Error('Refusing non-isolated PostgreSQL DB for Sadhaka integration');
}

test('original Ista factory + generic Sadhaka: native callback and typed first output',
{skip:!enabled,timeout:45000},async()=>{
  process.env.NODE_ENV='test'; // permit isolated local detached children, never GKE
  process.env.GCP_PROJECT ||= 'awfl-us';
  const pool=new pg.Pool({connectionString:DB,max:5});
  const storage=new PostgresStorage({pool});
  await storage.initialize();
  const collection='reconcileSadhaka_'+randomUUID().replaceAll('-','');
  const records=new DocumentAtomicRecords({storage,collection});
  const store=new NativeMemoryExecutionPilotStore({records});
  const releases=await localReleases(REPORT);
  const root=await releases.active('helpers-SadhakaNativeFixture');
  assert.ok(root,'compiled Sadhaka native fixture is required');
  const executionId='native_'+randomUUID().replaceAll('-','');
  const identity={userId:'sadhaka-'+randomUUID().replaceAll('-',''),projectId:'reconcile-project'};
  await store.create({executionId,...identity,workflowName:root.workflowName,
    artifactSha256:root.sha256,protocolVersion:2,
    allowedOperations:[...root.allowedOperations],
    parallelVersion:root.parallelVersion,streamIpcVersion:root.streamIpcVersion,
    trustedGlobalsVersion:root.trustedGlobalsVersion,input:{workflowName:TARGET,env:{
      ...identity,sessionId:'reconcile-session',
      model:'gpt-6.1-terra',BASE_URL:'https://jobs-4wmfqir74q-uc.a.run.app',
      workdir:'/tmp/reconcile-sandbox',background:false,
    }}});
  const answer={title:'Fixture title',summary:'Fixture summary'};
  const fixture=makeReconciliationFixture({scenario:'basic'});
  const seen=[],missing=[],requests=[],callbackDeliveries=[];
  let modelCalls=0, callbackSequence=0, accounted=0;
  const app=express();
  app.use(express.json());
  app.use((req,_res,next)=>{req.userId=identity.userId;req.projectId=identity.projectId;next();});
  app.use('/llm',createLlmRouter({
    apiKeyForUser:async()=> 'mock-key-not-used',
    recordUsage:async()=>{accounted++;},
    adapters:{openai:{chat:async ({tools,tool_choice})=>{
      modelCalls++;
      assert.equal(tool_choice?.function?.name,'summaries');
      const matches=tools.filter(t=>t.function?.name==='summaries');
      assert.equal(matches.length,1,'typed output schema must be unique');
      assert.equal(matches[0].function.parameters.type,'object');
      assert.equal(matches[0].function.parameters.additionalProperties,false);
      assert.ok(tools.every(t=>!('workflowName' in t)));
      if(CASE==='provider-error') throw new Error('Fixture provider unavailable');
      const functionName=CASE==='wrong-tool'?'NOT_SUMMARIES':'summaries';
      const argumentsText=CASE==='malformed-json'?'{not json':
        JSON.stringify(CASE==='invalid-schema'?{title:'Fixture title'}:answer);
      return {message:CASE==='missing-tool'
        ? {role:'assistant',content:'No output function',tool_calls:[]}
        : {role:'assistant',content:'',tool_calls:[{id:'fixture-typed-answer',
          type:'function',function:{name:functionName,arguments:argumentsText}}]},
        usage:{prompt_tokens:5,completion_tokens:3,total_tokens:8}};
    }}}
  }));
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const llmUrl='http://127.0.0.1:'+server.address().port+'/llm/chat';
  const respond=async ({method,path,args,effectId})=>{
    requests.push({method,path,args});
    if (process.env.AWFL_SADHAKA_DEBUG === '1')
      console.log('SADHAKA_REQUEST',method,path,JSON.stringify(args?.body ?? {}).slice(0,200));
    if(method==='POST' && path==='/llm/chat') {
      if(!['codebase-ProjectManager','helpers-Convo'].includes(args.body?.workflow_name))
        return fixture.respond({method,path,args,effectId});
      assert.equal(args.body.validate_tool_arguments,true);
      assert.equal(args.body.tool_choice?.function?.name,'summaries');
      const matching=args.body.tools.filter(t=>t.function?.name==='summaries');
      assert.equal(matching.length,1,'typed output function must be provided once');
      assert.equal(matching[0].function.parameters.type,'object');
      assert.equal(matching[0].function.parameters.additionalProperties,false);
      assert.ok(args.body.tools.every(t=>!('workflowName' in t)));
      const response=await fetch(llmUrl,{method:'POST',
        headers:{'content-type':'application/json'},body:JSON.stringify(args.body)});
      return {code:response.status,body:await response.json()};
    }
    if(method==='POST' && path==='/callbacks/test-sadhaka') {
      callbackDeliveries.push(args.body);
      if(CASE==='callback-error') return {code:503,body:{error:'Callback rejected'}};
      return {code:200,body:{recorded:true}};
    }
    return fixture.respond({method,path,args,effectId});
  };
  const handlers=createReplayHttpHandlers({identity,fixtures:{},seen,missing,respond});
  const fixtureScript=Buffer.from('#!/bin/sh\n# Reconciliation fixture, no real commands\necho harmless\n');
  handlers['storage.object_get']=createNativeStorageEffectHandler({storage:{
    bucket:()=>({file:()=>({
      getMetadata:async()=>[{size:fixtureScript.length}],
      download:async()=>[fixtureScript],
    })}),
  }});
  handlers['callback.create']=async()=> ++callbackSequence===1
    ? {url:'https://jobs-4wmfqir74q-uc.a.run.app/callbacks/test-sadhaka'}
    : fixture.callbackCreate();
  handlers['callback.await']=async({args})=>{
    if(new URL(args.callback.url).pathname==='/callbacks/test-sadhaka') {
      assert.equal(callbackDeliveries.length,1,'native child must deliver its callback');
      return {http_request:{body:callbackDeliveries[0]}};
    }
    return fixture.callbackAwait({args});
  };
  handlers['log.write']=async()=>null;
  try {
    const result=await runNativeMemoryWorkflow({store,releases,handlers,executionId,...identity});
    if (process.env.AWFL_SADHAKA_DEBUG === '1')
      console.log('SADHAKA_RESULT',JSON.stringify(result));
    const failed=CASE!=='success';
    if(failed){
      assert.equal(TARGET,'codebase-ProjectManager');
      assert.equal(result.status,'failed',JSON.stringify(result));
      assert.equal((await store.get(executionId)).status,'failed');
      assert.ok(result.error?.message,'failed native completion needs a useful error');
      assert.equal(modelCalls,1);
      assert.equal(accounted,CASE==='provider-error'?0:1);
      if(['malformed-json','invalid-schema','wrong-tool'].includes(CASE))
        assert.match(result.error.message,/422|recorded Jobs HTTP|invalid/i);
    }else{
      assert.deepEqual(result.message,answer);
      assert.equal(result.total_cost,TARGET==='codebase-ProjectManager'?0.00002:0.015,
        'the live Jobs router computes the model cost from usage');
      assert.equal((await store.get(executionId)).status,'completed');
      assert.equal(modelCalls,TARGET==='codebase-ProjectManager'?1:0);
      assert.equal(accounted,TARGET==='codebase-ProjectManager'?1:0);
      assert.equal(callbackDeliveries.length,1);
      assert.equal(missing.length,0,JSON.stringify(missing));
      assert.equal(fixture.messages().filter(m=>m.value?.role==='tool').length,0,
        'typed output is not a normal tool dispatch');
    }
    const replay=await runNativeMemoryWorkflow({store,releases,handlers:{},executionId,...identity});
    assert.deepEqual(replay,result);
    console.log('SADHAKA_NATIVE_PASS',JSON.stringify({target:TARGET,case:CASE,
      callbackDeliveries:callbackDeliveries.length,result,requests:requests.length}));
  } finally {
    await new Promise(resolve=>server.close(resolve));
    for(const document of await storage.query({collection}))
      await storage.delete(document.path);
    await storage.close();
    await pool.end();
  }
});
