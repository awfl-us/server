import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {createLlmRouter} from '../llm.js';
import {chat} from '../providers/openai.js';
import {createResponseStream} from './responseStream.js';

const base={model:'gpt-6.1-terra',messages:[{role:'user',content:'hi'}],sessionId:'s',max_completion_tokens:100,stream_response:true};
const usage={input_tokens:20,output_tokens:5,total_tokens:25,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}};
const message={type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Hi there'}]};
const final=(output=[message],status='completed')=>({id:'resp_test',model:base.model,status,output,usage});
const frame=e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n';
const wire=(output,status='completed')=>[
  {type:'response.output_text.delta',delta:'Hi ',output_index:0,content_index:0,sequence_number:5},
  {type:'response.function_call_arguments.delta',delta:'secret',sequence_number:6},
  {type:'response.output_text.delta',delta:'there',output_index:0,content_index:0,sequence_number:9},
  {type:'response.'+status,response:final(output,status)}
].map(frame).join('');

function harness({output,status='completed',factory=true,rejectPublish=false,throwFactory=false,customAdapter}={}){
  const events=[],billed=[],requests=[],scopes=[];
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.userId='auth-user';req.projectId='auth-project';next();});
  const provider={chat:(params,opts)=>chat(params,{...opts,fetch:async(url,init)=>{
    const payload=JSON.parse(init.body);requests.push(payload);
    return new Response(payload.stream?wire(output,status):JSON.stringify(final(output,status)),
      {headers:{'content-type':payload.stream?'text/event-stream':'application/json'}});
  }})};
  app.use('/llm',createLlmRouter({
    apiKeyForUser:async()=> 'fixture-only',
    recordUsage:async e=>billed.push(e),
    adapters:{openai:customAdapter||provider},
    responseStreamFactory:factory?({scope})=>{
      scopes.push(scope);if(throwFactory)throw Error('unavailable');
      return createResponseStream({scope,bus:{publish:e=>{
        if(rejectPublish)return Promise.reject(Error('unavailable'));
        events.push(e);return Promise.resolve();
      }}});
    }:null
  }));
  return {events,billed,requests,scopes,post:body=>request(app).post('/llm/chat').send(body)};
}

test('actual Jobs/SDK foreground opt-in emits ordered scoped deltas and returns the same responseId',async()=>{
  const h=harness(),r=await h.post({...base,userId:'fake-user',projectId:'fake-project',messages:[...base.messages,{role:'assistant',content:'old',responseId:'old-id'}]});
  assert.equal(r.status,200);assert.equal(r.body.message.content,'Hi there');
  assert.equal(h.requests[0].stream,true);assert.ok(h.requests[0].input.every(m=>!('responseId' in m)));
  assert.deepEqual(h.scopes,[{userId:'auth-user',projectId:'auth-project',sessionId:'s'}]);
  assert.deepEqual(h.events.map(e=>e.type),['response.started','response.delta','response.delta','response.provider_finished']);
  assert.deepEqual(h.events.map(e=>e.sequence),[0,1,2,3]);
  assert.ok(h.events.every(e=>e.responseId===r.body.message.responseId&&e.attemptId===h.events[0].attemptId));
  assert.equal(h.events.filter(e=>e.type==='response.delta').map(e=>e.data.content).join(''),'Hi there');
  assert.equal(h.billed.length,1);
  const next=await h.post(base);assert.notEqual(next.body.message.responseId,r.body.message.responseId);
});

test('no factory, missing/false opt-in, structured, forced or missing session remain ordinary completions',async()=>{
  for(const [opts,extra] of [[{factory:false},{}],[{}, {stream_response:undefined}],[{}, {stream_response:false}],
    [{},{response_format:{type:'json_object'}}],[{},{tools:[{type:'function',function:{name:'inspect',parameters:{type:'object'}}}],tool_choice:{type:'function',function:{name:'inspect'}}}],[{},{sessionId:undefined}]]){
    const h=harness(opts);const r=await h.post({...base,...extra});
    assert.equal(r.status,200);assert.equal(h.requests[0].stream,undefined);
    assert.equal(r.body.message.responseId,undefined);assert.deepEqual(h.events,[]);
  }
});

test('provider terminal failure and invalid tool args are billed but not declared finished',async()=>{
  const invalid={type:'function_call',call_id:'c',name:'inspect',arguments:'{}',status:'completed'};
  const h=harness({status:'incomplete'});const r=await h.post(base);
  assert.equal(r.status,502);assert.equal(h.billed.length,1);assert.equal(h.events.at(-1).type,'response.failed');
  const k=harness({output:[invalid]});const q=await k.post({...base,validate_tool_arguments:true,tools:[{type:'function',function:{name:'inspect',parameters:{type:'object',properties:{key:{type:'string'}},required:['key']}}}]});
  assert.equal(q.status,422);assert.equal(k.billed.length,1);assert.equal(k.events.at(-1).type,'response.failed');
});

test('publisher failure and unavailable factory preserve final response and billing',async()=>{
  for(const opts of [{rejectPublish:true},{throwFactory:true}]){
    const h=harness(opts);const r=await h.post(base);assert.equal(r.status,200);assert.equal(r.body.message.content,'Hi there');assert.equal(h.billed.length,1);
  }
});
