/**
 * AWFL reconciliation fixture runner: real generated Rust + native effect journal,
 * deterministic in-process Jobs responses. No model, production DB or GCP calls.
 *
 * Deliberately fail closed on unrecognized HTTP requests; assertions inspect
 * the modeled persisted messages, not merely the terminal workflow return.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { runLocalProjectManager } from './nativeLocalDev.mjs';
import { createNativeStorageEffectHandler } from '../workflows/native/storageEffects.js';

export const scenarios = Object.freeze(['basic', 'no-query']);

export function makeReconciliationFixture({ scenario = 'basic', query = 'Read the config.', sessionId = 'reconcile-session' } = {}) {
  if (!scenarios.includes(scenario)) throw new Error('Unknown reconciliation scenario: ' + scenario);
  const docs = new Map();
  if (scenario === 'no-query') docs.set(
    `convo.sessions/${sessionId}/messages/prior-turn`,
    {create_time:Date.now()/1000-60,value:{role:'user',content:'Previous user turn'}});
  const requests = [];
  const modelRequests = [];
  const llmReplies = [{role:'assistant',content:'The configuration enables debug logging.'}];
  const key = body => `${body.collection}/${body.id}`;
  const messages = () => [...docs.entries()]
    .filter(([id]) => id.includes('messages/'))
    .map(([id, contents]) => ({id:id.split('/').at(-1),...contents}))
    .sort((a,b)=>(a.create_time||0)-(b.create_time||0));
  const ok = body => ({code:200,body});
  const respond = ({method,path,args,effectId}) => {
    const body = args.body || {};
    requests.push({method,path,effectId,body});
    switch(`${method} ${path}`) {
      case 'POST /firebase/create': {
        assert.ok(body.collection && body.id, 'firebase.create requires collection/id');
        const id=key(body);
        if(docs.has(id)) return {code:409,body:{error:'Document already exists'}};
        docs.set(id,body.contents || {});
        return ok({id:String(body.id)});
      }
      case 'POST /firebase/update': {
        const id=key(body);
        docs.set(id,{...(docs.get(id)||{}),...(body.contents||{})});
        return ok({message:'Document updated successfully'});
      }
      case 'POST /firebase/read': {
        const content=docs.get(key(body));
        return content ? ok({...content,subcollections:[]}) : {code:404,body:{error:'Document not found'}};
      }
      case 'POST /firebase/delete': {
        docs.delete(key(body));
        return ok({message:'Document deleted successfully'});
      }
      case 'POST /firebase/locks/acquire': return ok({acquired:true,owner:body.owner,created:1700000000});
      case 'POST /firebase/locks/release': return ok({released:true});
      case 'POST /firebase/segmentsForSession': return ok({segments:[{end:Date.now()/1000,windowSeconds:Number(body.windowSeconds||1200)}]});
      case 'POST /firebase/list': {
        const filtered=messages().filter(v => v.create_time>=Number(body.start||0)&&v.create_time<=Number(body.end||Number.MAX_VALUE));
        return ok({documents:filtered.map(item=>({id:item.id,data:item,subcollections:[]}))});
      }
      case 'POST /context/topicContextYoj/run': {
        const seen=messages().map(x=>x.value||x).filter(x=>x.role);
        return ok({yoj:seen.length?seen:[{role:'user',content:query}]});
      }
      case 'POST /llm/chat': {
        modelRequests.push(body);
        assert.ok(Array.isArray(body.messages),'llm must receive messages array');
        return ok({message:llmReplies.shift() || {role:'assistant',content:'Final response.'},
          total_cost:0,usage:{completion_tokens:10,completion_tokens_details:{accepted_prediction_tokens:0,audio_tokens:0,reasoning_tokens:0,rejected_prediction_tokens:0},prompt_tokens:20,prompt_tokens_details:{audio_tokens:0,cached_tokens:0},total_tokens:30}});
      }
      case 'GET /agents/session/reconcile-session': return ok({sessionId,agentId:'default'});
      case 'GET /agents/default/tools': return ok({tools:[]});
      case 'GET /tools/list': case 'GET /jobs/tools/list': return ok({items:[]});
      case 'GET /jobs/tasks/by-session/reconcile-session': return ok({tasks:[]});
      case 'POST /workflows/exec/status/update': return ok({});
      case 'POST /callbacks': return ok({id:'fixture-callback'});
      case 'POST /producer/start': return ok(true);
      case 'POST /workflows/events': return ok({ok:true});
      case 'POST /events': case 'POST /events/response': return ok({ok:true});
      default: throw new Error(`Unmocked AWFL endpoint ${method} ${path} (${effectId})`);
    }
  };
  return {docs,requests,modelRequests,respond,messages,sessionId,scenario,query};
}

export async function runReconciliationScenario({reportPath,scenario='basic', log=()=>{},
  maxTransitions=120, strictBackground=false}) {
  if(!reportPath) throw new Error('--report is required; compile native workflows first');
  const fixture=makeReconciliationFixture({scenario});
  const input={fund:2,env:{userId:'reconcile-user',projectId:'reconcile-project',
    sessionId:fixture.sessionId,model:'gpt-6.1-terra',
    BASE_URL:'https://jobs-4wmfqir74q-uc.a.run.app',background:false,
    workdir:'/tmp/reconcile-sandbox'}};
  if(scenario!=='no-query') input.query=fixture.query;
  // Trusted project identity needed for local native child routing only; no GCP calls.
  process.env.GCP_PROJECT ||= 'awfl-us';
  process.env.NODE_ENV = 'test';
  const mockFile=Buffer.from('#!/bin/sh\n# Reconciliation test fixture, not executable\necho harmless\n');
  const storageHandler=createNativeStorageEffectHandler({storage:{
    bucket: name => ({file: key => {
      assert.equal(name,'awfl-us-workflow-files');
      assert.equal(key,'scripts/agent.sh','unexpected storage fixture path');
      return {getMetadata:async()=>[{size:mockFile.length}],download:async()=>[mockFile]};
    }})
  }});
  const callbackFixtureHandlers={
    'callback.create': async () => ({url:'https://jobs-4wmfqir74q-uc.a.run.app/callbacks/fixture-callback'}),
    'callback.await': async () => ({http_request:{body:{output:'fixture script completed',exitCode:0,error:''}}}),
  };
  const native=await runLocalProjectManager({reportPath:resolve(reportPath),
    input,identity:{userId:'reconcile-user',projectId:'reconcile-project'},
    respondHttp:fixture.respond,storageHandler,callbackFixtureHandlers,maxTransitions,log,
    drainDetached:true,drainTimeoutMs:10000});
  return {scenario,native,strictBackground,requests:fixture.requests,modelRequests:fixture.modelRequests,
    messages:fixture.messages()};
}

function assertBaseline(result) {
  assert.equal(result.native.status,'completed',result.native.error || 'native incomplete');
  assert.equal(result.native.error,undefined,'native emitted error');
  assert.equal(result.native.detachedDrainError,null,'detached work did not settle');
  if(result.strictBackground) assert.deepEqual(
    result.native.lanes.filter(x=>x.status==='failed'),[],
    'detached/native child execution failed');
  assert.deepEqual(result.native.missing,[],'unhandled native HTTP calls');
  const roles=result.messages.map(x=>x.value?.role||x.role).filter(Boolean);
  if(result.scenario==='basic') assert.equal(roles.filter(x=>x==='user').length,1,'duplicate user insert');
  else assert.equal(roles.filter(x=>x==='user').length,1,
    'nil query duplicated or dropped previously persisted user turn');
  assert.equal(roles.filter(x=>x==='assistant').length,1,'exactly one assistant response');
  assert.equal(result.modelRequests.length,1,'exactly one mock LLM request');
  return {scenario:result.scenario,status:result.native.status,
    effects:result.native.effectCount,modelCalls:result.modelRequests.length,
    messages:roles,elapsedMs:result.native.durationMs,
    failedBackgroundExecutions:result.native.lanes.filter(x=>x.status==='failed').length};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const arg=(flag,defaultValue)=>{const i=process.argv.indexOf(flag);return i<0?defaultValue:process.argv[i+1]};
  const reportPath=arg('--report',process.env.AWFL_NATIVE_LOCAL_BUILD_REPORT);
  const scenario=arg('--scenario','basic');
  const strictBackground=process.argv.includes('--strict-background');
  try{
    const r=await runReconciliationScenario({reportPath,scenario,strictBackground});
    const checked=assertBaseline(r);
    console.log('AWFL_RECONCILE_PASS '+JSON.stringify(checked));
  }catch(error){
    console.error('AWFL_RECONCILE_FAIL '+String(error?.stack||error));
    process.exitCode=1;
  }
}
