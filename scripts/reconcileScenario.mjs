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

export const scenarios = Object.freeze(['basic', 'no-query', 'tool-roundtrip', 'typed-tool-roundtrip']);

export function makeReconciliationFixture({ scenario = 'basic', query = 'Read the config.', sessionId = 'reconcile-session',
  typedToolDef = null } = {}) {
  if (!scenarios.includes(scenario)) throw new Error('Unknown reconciliation scenario: ' + scenario);
  if (scenario === 'typed-tool-roundtrip') {
    assert.equal(typedToolDef?.workflowName,'tools-CliTools',
      'typed dispatch needs the compiled, separate workflow mapping');
    assert.equal(typedToolDef?.function?.name,'READ_FILE');
    assert.equal(typedToolDef?.function?.parameters?.additionalProperties,false,
      'typed schema must be strict and derived');
  }
  const docs = new Map();
  if (scenario === 'no-query') docs.set(
    `convo.sessions/${sessionId}/messages/prior-turn`,
    {create_time:Date.now()/1000-60,value:{role:'user',content:'Previous user turn'}});
  const requests = [];
  const modelRequests = [];
  const callbackTools = new Map();
  const callbackDeliveries = new Map();
  let callbackSequence = 0;
  const isTool = scenario === 'tool-roundtrip' || scenario === 'typed-tool-roundtrip';
  const llmReplies = isTool
    ? [{role:'assistant',content:'',tool_calls:[{type:'function',id:'read-fixture-1',
        function:{name:'READ_FILE',arguments:JSON.stringify({filepath:'/tmp/reconcile-config.json'})}}]},
      {role:'assistant',content:'The configuration enables debug logging.'}]
    : [{role:'assistant',content:'The configuration enables debug logging.'}];
  const legacyToolDef={type:'function',function:{name:'READ_FILE',description:'Read a file',
    parameters:{type:'object',properties:{filepath:{type:'string'}},required:['filepath']}},
    workflowName:'tools-CliTools'};
  const toolDef=typedToolDef || legacyToolDef;
  const callbackCreate=async()=>({url:`https://jobs-4wmfqir74q-uc.a.run.app/callbacks/test-${++callbackSequence}`});
  const callbackAwait=async({args})=>{
    const id=new URL(args.callback.url).pathname.split('/').at(-1);
    if(callbackDeliveries.has(id))
      return {http_request:{body:callbackDeliveries.get(id)}};
    const tool=callbackTools.get(id);
    if(!tool) throw new Error(`No tool registered for callback ${id}`);
    return {http_request:{body:tool==='READ_FILE'
      ? {content:'{"debug":true}',filepath:'/tmp/reconcile-config.json'}
      : {output:'fixture script completed',exitCode:0,error:''}}};
  };
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
      case 'POST /context/collapse/indexer/run': return ok({});
      case 'POST /llm/chat': {
        modelRequests.push(body);
        assert.ok(Array.isArray(body.messages),'llm must receive messages array');
        if (scenario === 'typed-tool-roundtrip' && ['codebase-ProjectManager','helpers-Convo'].includes(body.workflow_name)) {
          const readTools=body.tools.filter(tool=>tool.function?.name==='READ_FILE');
          assert.deepEqual(readTools,[{type:toolDef.type,function:toolDef.function}],
            'generated READ_FILE schema must be preserved and routing metadata removed');
          assert.ok(body.tools.every(tool=>!('workflowName' in tool)),
            'no internal routing metadata may reach the model');
          const names=body.tools.map(tool=>tool.function?.name);
          assert.equal(new Set(names).size,names.length,
            'model payload cannot advertise duplicate function names');
          assert.ok(names.includes('RUN_COMMAND'),'unrelated CLI tools must survive override');
          assert.ok(names.includes('CHECK_TASKS'),'unrelated task tools must survive override');
        }
        // Background Ista completions require machine-readable JSON. Never
        // consume a foreground scripted tool turn for a background call.
        const structured = {
          'context-ContextCollapser-SegKala': {groups:[]},
          'Summaries-Convo': {title:'Fixture conversation',summary:'Read-only configuration discussion.'},
          'Summaries-Session': {title:'Fixture conversation',summary:'Read-only configuration discussion.'},
          'Summaries-Week': {title:'Fixture week',summary:'Read-only configuration discussion.'},
          'Summaries-Term': {title:'Fixture term',summary:'Read-only configuration discussion.'},
          'assistant-ExtractTopics-Convo': {topics:[],nuggets:[],reflections:[],artifacts:[],shouldSaveReflection:false},
          'assistant-ExtractTopics-Session': {topics:[],nuggets:[],reflections:[],artifacts:[],shouldSaveReflection:false},
          'assistant-ExtractTopics-Week': {topics:[],nuggets:[],reflections:[],artifacts:[],shouldSaveReflection:false},
          'assistant-ExtractTopics-Term': {topics:[],nuggets:[],reflections:[],artifacts:[],shouldSaveReflection:false},
        };
        // The reconciled wip-old Strider now uses Sadhaka's typed
        // side-call tool rather than JSON-mode completions. The model
        // fixture must answer the requested output function, without
        // consuming the foreground ProjectManager replies.
        const outputTool=body.tool_choice?.function?.name;
        if (outputTool && ['summaries','topicInfos','collapsed','collapseResponse','collapseResponses'].includes(outputTool)) {
          const payload=outputTool==='summaries'
            ? {title:'Fixture conversation',summary:'Read-only configuration discussion.'}
            : outputTool==='topicInfos'
              ? {topics:[],nuggets:[],reflections:[],artifacts:[],shouldSaveReflection:false}
              : {groups:[]};
          return ok({message:{role:'assistant',content:'',tool_calls:[{
            id:'background-output-'+outputTool,type:'function',
            function:{name:outputTool,arguments:JSON.stringify(payload)}
          }]},total_cost:0,usage:{completion_tokens:10,
            completion_tokens_details:{accepted_prediction_tokens:0,audio_tokens:0,reasoning_tokens:0,rejected_prediction_tokens:0},
            prompt_tokens:20,prompt_tokens_details:{audio_tokens:0,cached_tokens:0},total_tokens:30}});
        }
        if(body.response_format?.type === 'json_object') {
          const payload = structured[body.workflow_name];
          if(!payload) throw new Error(`Unmocked JSON completion for workflow ${body.workflow_name}`);
          return ok({message:{role:'assistant',content:JSON.stringify(payload)},
            total_cost:0,usage:{completion_tokens:10,completion_tokens_details:{accepted_prediction_tokens:0,audio_tokens:0,reasoning_tokens:0,rejected_prediction_tokens:0},prompt_tokens:20,prompt_tokens_details:{audio_tokens:0,cached_tokens:0},total_tokens:30}});
        }
        if(body.response_format?.type && body.response_format.type !== 'text') throw new Error(`Unmocked LLM response format: ${body.response_format.type}`);
        return ok({message:llmReplies.shift() || {role:'assistant',content:'Final response.'},
          total_cost:0,usage:{completion_tokens:10,completion_tokens_details:{accepted_prediction_tokens:0,audio_tokens:0,reasoning_tokens:0,rejected_prediction_tokens:0},prompt_tokens:20,prompt_tokens_details:{audio_tokens:0,cached_tokens:0},total_tokens:30}});
      }
      case 'GET /agents/session/reconcile-session': return ok({sessionId,agentId:'default'});
      case 'GET /agents/default/tools': return ok({tools:isTool ? ['READ_FILE'] : []});
      case 'GET /tools/list': case 'GET /jobs/tools/list': return ok({items:isTool ? [toolDef] : []});
      case 'GET /jobs/tasks/by-session/reconcile-session': return ok({tasks:[]});
      case 'POST /workflows/exec/status/update': return ok({});
      case 'POST /callbacks': return ok({id:String(body.callback_url||'').split('/').at(-1)});
      case 'POST /producer/start': return ok(true);
      case 'POST /workflows/events': return ok({ok:true});
      case 'POST /events': case 'POST /events/response': {
        if(body.data?.callback_id && body.data?.tool_call?.function?.name)
          callbackTools.set(body.data.callback_id,body.data.tool_call.function.name);
        return ok({ok:true});
      }
      default:
        if (method==='POST' && /^\/callbacks\/test-\d+$/.test(path)) {
          callbackDeliveries.set(path.split('/').at(-1),body);
          return ok({recorded:true});
        }
        throw new Error(`Unmocked AWFL endpoint ${method} ${path} (${effectId})`);
    }
  };
  return {docs,requests,modelRequests,callbackTools,callbackCreate,callbackAwait,
    respond,messages,sessionId,scenario,query};
}

export async function runReconciliationScenario({reportPath,scenario='basic', log=()=>{},
  maxTransitions=120, strictBackground=false, typedToolDef=null, executionMode='durable', llmTransport=null}) {
  if(!reportPath) throw new Error('--report is required; compile native workflows first');
  const fixture=makeReconciliationFixture({scenario,typedToolDef});
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
    'callback.create':fixture.callbackCreate,
    'callback.await':fixture.callbackAwait,
  };
  const native=await runLocalProjectManager({reportPath:resolve(reportPath),
    input,identity:{userId:'reconcile-user',projectId:'reconcile-project'},
    respondHttp:async request=>{
      const expected=fixture.respond(request);
      return llmTransport && request.path==='/llm/chat'
        ? llmTransport(request.args.body,expected) : expected;
    },storageHandler,callbackFixtureHandlers,maxTransitions,log,
    drainDetached:true,drainTimeoutMs:20000,executionMode});
  return {scenario,native,strictBackground,requests:fixture.requests,modelRequests:fixture.modelRequests,
    messages:fixture.messages()};
}

function assertBaseline(result) {
  assert.equal(result.native.status,'completed',result.native.error || 'native incomplete');
  assert.equal(result.native.error,undefined,'native emitted error');
  assert.equal(result.native.detachedDrainError,null,'detached work did not settle');
  if(result.strictBackground) assert.deepEqual(
    result.native.lanes.filter(x=>x.status==='failed' || x.status==='waiting_effect'),[],
    'detached/native child execution failed');
  assert.deepEqual(result.native.missing,[],'unhandled native HTTP calls');
  const roles=result.messages.map(x=>x.value?.role||x.role).filter(Boolean);
  if(result.scenario!=='no-query') assert.equal(roles.filter(x=>x==='user').length,1,'duplicate user insert');
  else assert.equal(roles.filter(x=>x==='user').length,1,
    'nil query duplicated or dropped previously persisted user turn');
  const foregroundRequests=result.modelRequests.filter(x=>['codebase-ProjectManager','helpers-Convo'].includes(x.workflow_name) && !x.tool_choice?.function?.name);
  const backgroundRequests=result.modelRequests.filter(x=>!['codebase-ProjectManager','helpers-Convo'].includes(x.workflow_name) || Boolean(x.tool_choice?.function?.name));
  const isTool=result.scenario==='tool-roundtrip' || result.scenario==='typed-tool-roundtrip';
  assert.equal(roles.filter(x=>x==='assistant').length,isTool?2:1,
    'incorrect number of assistant messages');
  if(isTool) {
    assert.equal(roles.filter(x=>x==='tool').length,1,'missing or duplicate tool result');
    const stored=result.messages.map(x=>x.value||x);
    const called=stored.find(x=>x.tool_calls?.length)?.tool_calls?.[0];
    const tool=stored.find(x=>x.role==='tool');
    assert.equal(called?.id,'read-fixture-1','tool invocation id mismatch');
    assert.equal(tool?.tool_call_id,'read-fixture-1','tool response id mismatch');
    assert.deepEqual(JSON.parse(tool?.content||'{}'),{
      content:'{"debug":true}',filepath:'/tmp/reconcile-config.json'});
    const next=foregroundRequests[1]?.messages||[];
    const callIdx=next.findIndex(x=>x.role==='assistant'&&x.tool_calls?.some(y=>y.id==='read-fixture-1'));
    const resultIdx=next.findIndex(x=>x.role==='tool'&&x.tool_call_id==='read-fixture-1');
    assert.ok(callIdx>=0 && resultIdx>callIdx,
      'LLM continuation missing ordered assistant-call/tool-result pair');
    assert.equal(next[resultIdx].content,tool.content,
      'LLM continuation tool content differs from persisted result');
    assert.equal(next.filter(x=>x.role==='user').length,1,
      'LLM continuation injected an unexpected user message');
  }
  assert.equal(foregroundRequests.length,isTool?2:1,
    'incorrect foreground LLM request count');
  if(result.strictBackground) assert.ok(backgroundRequests.length >= (isTool?4:2),
    'expected background LLM requests were missing');
  return {scenario:result.scenario,status:result.native.status,
    effects:result.native.effectCount,modelCalls:foregroundRequests.length,
    backgroundModelCalls:backgroundRequests.length,
    messages:roles,elapsedMs:result.native.durationMs,
    failedBackgroundExecutions:result.native.lanes.filter(x=>x.status==='failed').length};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const arg=(flag,defaultValue)=>{const i=process.argv.indexOf(flag);return i<0?defaultValue:process.argv[i+1]};
  const reportPath=arg('--report',process.env.AWFL_NATIVE_LOCAL_BUILD_REPORT);
  const scenario=arg('--scenario','basic');
  const strictBackground=process.argv.includes('--strict-background');
  const executionMode=process.argv.includes('--memory')?'memory':'durable';
  try{
    const r=await runReconciliationScenario({reportPath,scenario,strictBackground,executionMode});
    const checked=assertBaseline(r);
    console.log('AWFL_RECONCILE_PASS '+JSON.stringify(checked));
  }catch(error){
    console.error('AWFL_RECONCILE_FAIL '+String(error?.stack||error));
    process.exitCode=1;
  }
}
