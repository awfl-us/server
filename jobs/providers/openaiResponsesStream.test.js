import test from 'node:test';
import assert from 'node:assert/strict';
import { chat } from './openai.js';
import { readResponsesStream } from './openaiResponsesStream.js';

const usage={input_tokens:20,output_tokens:8,total_tokens:28,input_tokens_details:{cached_tokens:4},output_tokens_details:{reasoning_tokens:0}};
const message=text=>({type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text}]});
const tool={type:'function_call',id:'fc_item',call_id:'call_123',name:'inspect',arguments:'{"a":1}',status:'completed'};
const delta=(content,seq=1)=>({type:'response.output_text.delta',delta:content,output_index:0,content_index:0,sequence_number:seq});
const end=(status='completed',output=[message('Hi 🌍'),tool])=>({type:'response.'+status,response:{id:'resp_test',model:'gpt-6.1-terra',status,output,usage}});
const frame=event=>new TextEncoder().encode('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');
const params={apiKey:'fixture-only',model:'gpt-6.1-terra',messages:[{role:'user',content:'Inspect'}],max_tokens:100};

test('SDK forwards each UTF-8 text delta before completion and finalizes from full terminal response', {timeout:5000}, async()=>{
  let controller, first, second;
  const firstSeen=new Promise(resolve=>{first=resolve;});
  const secondSeen=new Promise(resolve=>{second=resolve;});
  const received=[];
  let completed=false;
  const response=chat(params,{fetch:async(url,init)=>{
    assert.equal(new URL(url).pathname,'/v1/responses');
    assert.equal(JSON.parse(init.body).stream,true);
    return new Response(new ReadableStream({start(c){controller=c;c.enqueue(frame(delta('Hi ',1)));}}),
      {headers:{'content-type':'text/event-stream','x-request-id':'req_fixture'}});
  },onDelta:event=>{received.push(event);if(received.length===1)first();else second();}}).then(r=>{completed=true;return r;});
  await firstSeen;
  assert.equal(completed,false);
  const bytes=frame(delta('🌍',2));
  const emoji=bytes.findIndex(x=>x===0xf0);
  controller.enqueue(bytes.slice(0,emoji+2));
  controller.enqueue(bytes.slice(emoji+2));
  await secondSeen;
  assert.equal(completed,false);
  controller.enqueue(frame({type:'response.function_call_arguments.delta',delta:'secret tool args',output_index:1,sequence_number:3}));
  controller.enqueue(frame({type:'response.reasoning_text.delta',delta:'private reasoning',sequence_number:4}));
  controller.enqueue(frame(end()));
  controller.close();
  const result=await response;
  assert.deepEqual(received,[{content:'Hi ',outputIndex:0,contentIndex:0,sequence:1},{content:'🌍',outputIndex:0,contentIndex:0,sequence:2}]);
  assert.equal(result.message.content,'Hi 🌍');
  assert.deepEqual(result.message.tool_calls,[{id:'call_123',type:'function',function:{name:'inspect',arguments:'{"a":1}'}}]);
  assert.equal(result.usage.total_tokens,28);
  assert.equal(result.usage.prompt_tokens_details.cached_tokens,4);
});

for(const status of ['failed','incomplete'])test('stream '+status+' preserves usage but does not dispatch partial tools',async()=>{
  const result=await chat(params,{onDelta:()=>{},fetch:async()=>new Response(
    new ReadableStream({start(c){c.enqueue(frame(delta('partial')));c.enqueue(frame(end(status)));c.close();}}),
    {headers:{'content-type':'text/event-stream'}})});
  assert.equal(result.message,null);
  assert.equal(result.failure,'response_not_completed');
  assert.equal(result.usage.total_tokens,28);
});

test('EOF before terminal fails closed; no partial completion',async()=>{
  await assert.rejects(chat(params,{onDelta:()=>{},fetch:async()=>new Response(frame(delta('partial')),
    {headers:{'content-type':'text/event-stream'}})}),/before a terminal event/);
});

test('throwing and rejecting sinks are isolated, and later deltas are not queued',async()=>{
  for(const make of [()=>{throw Error('subscriber gone');},()=>Promise.reject(Error('subscriber gone'))]){
    let count=0;
    async function* events(){yield delta('a');yield delta('b',2);yield end();}
    const result=await readResponsesStream(events(),()=>{count++;return make();});
    assert.equal(result.status,'completed');assert.equal(count,1);
  }
});

test('structured and forced output stay nonstreamed even if a sink is supplied',async()=>{
  for(const extra of [{response_format:{type:'json_object'}},
    {tools:[{type:'function',function:{name:'inspect',parameters:{type:'object'}}}],tool_choice:{type:'function',function:{name:'inspect'}}}]){
    const result=await chat({...params,...extra},{onDelta:()=>assert.fail('nonstreamed request delivered delta'),
      fetch:async(_url,init)=>{
        assert.equal(JSON.parse(init.body).stream,undefined);
        return new Response(JSON.stringify(end().response),{headers:{'content-type':'application/json'}});
      }});
    assert.equal(result.message.content,'Hi 🌍');
  }
});
