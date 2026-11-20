/** Compiled Sadhaka fixture, real PostgreSQL native-memory worker and effect boundary.
 * No live providers, GCP, or publishing. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PostgresAtomicRecords} from '../storage/pilot/adapters/postgres.js';
import {NativeMemoryExecutionPilotStore} from '../storage/pilot/memoryExecutionState.js';
import {runNativeMemoryWorkflow} from '../workflows/native/memoryWorker.js';
import {localReleases,createReplayHttpHandlers} from './nativeLocalDev.mjs';
import {makeReconciliationFixture} from './reconcileScenario.mjs';

const DB=process.env.PGTEST_URL;
const REPORT=process.env.AWFL_SADHAKA_NATIVE_REPORT;
const enabled=Boolean(DB && REPORT);
if (enabled) {
  const u=new URL(DB);
  if (!['127.0.0.1','localhost','[::1]'].includes(u.hostname) ||
      u.pathname!=='/awfl_reconcile')
    throw new Error('Refusing non-isolated PostgreSQL DB for Sadhaka integration');
}

test('original Ista factory + generic Sadhaka: native callback and typed first output',
{skip:!enabled,timeout:45000},async()=>{
  process.env.GCP_PROJECT ||= 'awfl-us';
  const pool=new pg.Pool({connectionString:DB,max:5});
  const records=new PostgresAtomicRecords({pool,table:'reconcile_sadhaka_integration'});
  await records.initialize();
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
    trustedGlobalsVersion:root.trustedGlobalsVersion,input:{env:{
      ...identity,sessionId:'reconcile-session',
      model:'gpt-6.1-terra',BASE_URL:'https://jobs-4wmfqir74q-uc.a.run.app',
      workdir:'/tmp/reconcile-sandbox',background:false,
    }}});
  const answer={title:'Fixture title',summary:'Fixture summary'};
  const fixture=makeReconciliationFixture({scenario:'basic'});
  const seen=[],missing=[],requests=[],callbackDeliveries=[];
  let modelCalls=0;
  const respond=({method,path,args,effectId})=>{
    requests.push({method,path,args});
    if (process.env.AWFL_SADHAKA_DEBUG === '1')
      console.log('SADHAKA_REQUEST',method,path,JSON.stringify(args?.body ?? {}).slice(0,200));
    if(method==='POST' && path==='/llm/chat') {
      modelCalls++;
      throw Error('Child fixture must not call the model');
    }
    if(method==='POST' && path==='/callbacks/test-sadhaka') {
      callbackDeliveries.push(args.body);
      return {code:200,body:{recorded:true}};
    }
    return fixture.respond({method,path,args,effectId});
  };
  const handlers=createReplayHttpHandlers({identity,fixtures:{},seen,missing,respond});
  handlers['callback.create']=async()=>({
    url:'https://jobs-4wmfqir74q-uc.a.run.app/callbacks/test-sadhaka'});
  handlers['callback.await']=async({args})=>{
    assert.equal(new URL(args.callback.url).pathname,'/callbacks/test-sadhaka');
    assert.equal(callbackDeliveries.length,1,'the native child must deliver its callback');
    return {http_request:{body:callbackDeliveries[0]}};
  };
  handlers['log.write']=async()=>null;
  try {
    const result=await runNativeMemoryWorkflow({store,releases,handlers,executionId,...identity});
    if (process.env.AWFL_SADHAKA_DEBUG === '1')
      console.log('SADHAKA_RESULT',JSON.stringify(result));
    assert.deepEqual(result.message,answer);
    assert.equal(result.total_cost,0.015);
    assert.equal((await store.get(executionId)).status,'completed');
    assert.equal(modelCalls,0);
    assert.equal(callbackDeliveries.length,1);
    assert.equal(missing.length,0,JSON.stringify(missing));
    const replay=await runNativeMemoryWorkflow({store,releases,handlers:{},executionId,...identity});
    assert.deepEqual(replay,result);
    console.log('SADHAKA_NATIVE_PASS',JSON.stringify({callbackDeliveries:callbackDeliveries.length,result,requests:requests.length}));
  } finally {
    await records.delete(executionId);
    await records.close();
  }
});
