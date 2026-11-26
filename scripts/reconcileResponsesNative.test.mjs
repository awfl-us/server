// Exercise the real Jobs router and OpenAI SDK using compiled Project Manager
// inputs and deterministic provider responses. Never uses a real API key.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {createLlmRouter} from '../jobs/llm.js';
import {chat} from '../jobs/providers/openai.js';
import {createResponseStream} from '../jobs/llm/responseStream.js';
import {runReconciliationScenario,makeReconciliationFixture} from './reconcileScenario.mjs';

async function throughResponses(body, expected, observations) {
  const output=[];
  const m=expected.body.message;
  if(m.content) output.push({type:'message',id:'msg_fixture',role:'assistant',status:'completed',
    content:[{type:'output_text',text:m.content,annotations:[]}]});
  for(const [i,call] of (m.tool_calls||[]).entries())
    output.push({type:'function_call',id:'fc_fixture_'+i,call_id:call.id,
      name:call.function.name,arguments:call.function.arguments,status:'completed'});
  const app=express();
  app.use(express.json());
  app.use((req,_res,next)=>{req.userId='responses-fixture-user';req.projectId='responses-fixture-project';next();});
  const billed=[],events=[];
  let wire;
  app.use('/llm',createLlmRouter({
    apiKeyForUser:async()=> 'fixture-only',
    recordUsage:async entry=>billed.push(entry),
    responseStreamFactory:({scope})=>createResponseStream({scope,bus:{publish:event=>{events.push(event);return Promise.resolve();}}}),
    adapters:{openai:{chat:(params,options)=>chat(params,{...options,fetch:async(url,init)=>{
      assert.equal(new URL(url).pathname,'/v1/responses');
      wire=JSON.parse(init.body);
      const final={id:'resp_fixture',model:params.model,status:'completed',output,
        usage:{input_tokens:20,output_tokens:10,total_tokens:30,
          input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};
      if(wire.stream){
        const frames=[];
        if(m.content)frames.push({type:'response.output_text.delta',delta:m.content,output_index:0,content_index:0,sequence_number:1});
        frames.push({type:'response.completed',response:final});
        return new Response(frames.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
      }
      return new Response(JSON.stringify(final),
        {status:200,headers:{'content-type':'application/json'}});
    }})}}
  }));
  const response=await request(app).post('/llm/chat').send(body);
  assert.equal(response.status,200,JSON.stringify(response.body));
  assert.ok(wire);
  assert.equal(wire.store,false);
  assert.equal(billed.length,1);
  assert.equal(billed[0].usage.total_tokens,30);
  assert.equal(response.body.usage.total_tokens,30);
  assert.equal(response.body.message.content||'',m.content||'');
  assert.deepEqual(response.body.message.tool_calls||[],m.tool_calls||[]);
  if(body.tool_choice?.function?.name)
    assert.deepEqual(wire.tool_choice,{type:'function',name:body.tool_choice.function.name});
  if(body.tools?.length) {
    assert.equal(wire.reasoning.effort,'none');
    assert.ok(wire.tools.every(t=>t.type==='function' && typeof t.name==='string' && !('workflowName' in t)));
  }
  for(const item of wire.input) {
    assert.ok(!('docId' in item) && !('create_time' in item) && !('responseId' in item));
  }
  observations.push({workflow:body.workflow_name,wire,requested:body.stream_response,responseId:response.body.message.responseId,events});
  return {code:response.status,body:response.body};
}

async function optedIn(fn) {
  const previous=process.env.AWFL_OPENAI_RESPONSES_MODELS;
  process.env.AWFL_OPENAI_RESPONSES_MODELS='gpt-6.1-terra';
  try {return await fn();}
  finally {
    if(previous===undefined) delete process.env.AWFL_OPENAI_RESPONSES_MODELS;
    else process.env.AWFL_OPENAI_RESPONSES_MODELS=previous;
  }
}

test('real Jobs and SDK roundtrip preserves parallel call IDs, forced tools and JSON mode',async()=>optedIn(async()=>{
  const observations=[];
  const f=makeReconciliationFixture({scenario:'tool-roundtrip'});
  const tools=[{type:'function',function:{name:'READ_FILE',parameters:{type:'object',
    properties:{filepath:{type:'string'}},required:['filepath']}}}];
  const base={model:'gpt-6.1-terra',sessionId:'fixture',messages:[{role:'user',content:'Inspect'}],
    tools,tool_choice:'auto',validate_tool_arguments:true,max_completion_tokens:200};
  const expected=f.respond({method:'POST',path:'/llm/chat',args:{body:base}});
  expected.body.message.tool_calls.push({...expected.body.message.tool_calls[0],id:'read-fixture-2'});
  const first=await throughResponses(base,expected,observations);
  const calls=first.body.message.tool_calls;
  const next={...base,messages:[...base.messages,first.body.message,
    ...calls.map(c=>({role:'tool',tool_call_id:c.id,content:'fixture result'}))]};
  await throughResponses(next,f.respond({method:'POST',path:'/llm/chat',args:{body:next}}),observations);
  const input=observations[1].wire.input;
  for(const c of calls) {
    const start=input.findIndex(i=>i.type==='function_call'&&i.call_id===c.id);
    const end=input.findIndex(i=>i.type==='function_call_output'&&i.call_id===c.id);
    assert.ok(start>=0&&end>start);
  }
  const forced={...base,tools:[{type:'function',function:{name:'summaries',parameters:{type:'object',
    properties:{title:{type:'string'},summary:{type:'string'}},required:['title','summary']}}}],
    tool_choice:{type:'function',function:{name:'summaries'}}};
  await throughResponses(forced,f.respond({method:'POST',path:'/llm/chat',args:{body:forced}}),observations);
  const json={...base,tools:[],tool_choice:undefined,response_format:{type:'json_object'},workflow_name:'Summaries-Convo'};
  await throughResponses(json,f.respond({method:'POST',path:'/llm/chat',args:{body:json}}),observations);
  assert.equal(observations.at(-1).wire.text.format.type,'json_object');
}));

const report=process.env.AWFL_NATIVE_LOCAL_BUILD_REPORT;
test('compiled Project Manager memory-mode tool continuation and Striders cross Responses adapter',
  {skip:!report,timeout:120000},async()=>optedIn(async()=>{
    const observations=[];
    const result=await runReconciliationScenario({reportPath:report,scenario:'tool-roundtrip',
      executionMode:'memory',strictBackground:true,llmTransport:(body,expected)=>throughResponses(body,expected,observations)});
    assert.equal(result.native.status,'completed',JSON.stringify(result.native.error));
    assert.equal(result.native.detachedDrainError,null);
    assert.deepEqual(result.native.missing,[]);
    assert.deepEqual(result.native.lanes.filter(x=>x.status==='failed'||x.status==='waiting_effect'),[]);
    const msgs=result.messages.map(x=>x.value||x);
    assert.equal(msgs.filter(x=>x.role==='user').length,1);
    assert.equal(msgs.filter(x=>x.role==='assistant').length,2);
    assert.equal(msgs.filter(x=>x.role==='tool').length,1);
    assert.equal(msgs.find(x=>x.role==='tool').tool_call_id,'read-fixture-1');
    const continuation=observations.find(x=>x.wire.input.some(i=>i.type==='function_call_output'&&i.call_id==='read-fixture-1'));
    assert.ok(continuation,'compiled continuation must replay the original call ID and result');
    assert.ok(continuation.wire.input.some(i=>i.type==='function_call'&&i.call_id==='read-fixture-1'));
    assert.ok(observations.some(x=>x.wire.tool_choice?.name==='summaries'),'typed summary side call must reach Responses');
    // Require the new contract when validating new workflow artifacts; old
    // deployed artifacts remain supported during the dependency rollout.
    if(process.env.AWFL_REQUIRE_STREAMING_WORKFLOW==='1'||observations.some(x=>x.requested===true)){
      const foreground=observations.filter(x=>['codebase-ProjectManager','helpers-Convo'].includes(x.workflow)&&!x.wire.tool_choice?.name);
      const internal=observations.filter(x=>!foreground.includes(x));
      assert.equal(foreground.length,2);
      assert.ok(foreground.every(x=>x.requested===true&&x.wire.stream===true&&x.responseId));
      assert.ok(internal.every(x=>x.requested!==true&&!x.wire.stream&&!x.responseId&&!x.events.length));
      const ids=foreground.map(x=>x.responseId);
      assert.equal(new Set(ids).size,2);
      assert.deepEqual(msgs.filter(x=>x.role==='assistant').map(x=>x.responseId),ids);
      assert.ok(foreground.every(x=>x.events.every(e=>e.responseId===x.responseId)));
      const contentEvents=result.requests.filter(x=>['/events','/workflows/events','/events/response'].includes(x.path)&&typeof x.body?.data?.content==='string'&&x.body.data.content.length>0);
      const finalEvent=contentEvents.find(x=>x.body.data.responseId===ids[1]);
      assert.ok(finalEvent,'persisted final message must correlate with legacy relay');
      const persistedAt=result.requests.findIndex(x=>x.path==='/firebase/create'&&x.body?.contents?.value?.responseId===ids[1]);
      assert.ok(persistedAt>=0&&result.requests.indexOf(finalEvent)>persistedAt,'relay must follow Ista persistence');
      console.log('COMPILED_STREAMING_IDENTITY_GATE',JSON.stringify({foreground:foreground.length,internal:internal.length,correlated:ids.length}));
    }
    console.log('COMPILED_RESPONSES_GATE',JSON.stringify({calls:observations.length,roles:msgs.map(m=>m.role)}));
}));
