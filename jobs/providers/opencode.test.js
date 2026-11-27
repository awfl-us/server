import test from 'node:test';
import assert from 'node:assert/strict';
import { chat, openCodeCost, OPENCODE_BASE_URL } from './opencode.js';

const usage = { input_tokens: 120, output_tokens: 10, total_tokens: 130,
  input_tokens_details: { cached_tokens: 100 }, cost: 0.000042 };
const result = { id:'resp_test', status:'completed', output:[
  {type:'function_call',call_id:'call_test',name:'inspect',arguments:'{}',status:'completed'}
], usage };
const params = {apiKey:'mock-key',model:'opencode/deepseek-v4.1-flash',
  messages:[{role:'user',content:'Inspect',docId:'private-metadata'}],
  tools:[{type:'function',function:{name:'inspect',parameters:{type:'object',properties:{}}}}],
  tool_choice:'auto',max_tokens:128};

test('Console Responses translation strips namespace and forwards tools with exact billed cost', async () => {
  let requests = 0;
  const response = await chat(params,{fetch:async(url,init)=>{
    requests++;
    assert.equal(String(url), OPENCODE_BASE_URL+'/responses');
    assert.equal(new Headers(init.headers).get('authorization'),'Bearer mock-key');
    const payload=JSON.parse(init.body);
    assert.equal(payload.model,'deepseek-v4.1-flash');
    assert.equal(payload.store,false);
    assert.equal(payload.max_output_tokens,128);
    assert.deepEqual(payload.input,[{role:'user',content:'Inspect'}]);
    assert.equal(payload.tools[0].strict,false);
    return new Response(JSON.stringify(result),{headers:{'content-type':'application/json'}});
  }});
  assert.equal(requests,1);
  assert.equal(response.totalCost,usage.cost);
  assert.equal(response.usage.prompt_tokens_details.cached_tokens,100);
  assert.equal(response.message.tool_calls[0].id,'call_test');
});

test('Console stream forwards deltas and bills terminal usage',async()=>{
  const deltas=[];
  const final={...result,output:[{type:'message',role:'assistant',status:'completed',
    content:[{type:'output_text',text:'hello'}]}]};
  const response=await chat(params,{onDelta:d=>{deltas.push(d.content);},fetch:async(url,init)=>{
    assert.equal(JSON.parse(init.body).stream,true);
    const events=[
      {type:'response.output_text.delta',delta:'hello',output_index:0,content_index:0,sequence_number:1},
      {type:'response.completed',response:final}
    ];
    return new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{
      headers:{'content-type':'text/event-stream'}});
  }});
  assert.deepEqual(deltas,['hello']);
  assert.equal(response.message.content,'hello');
  assert.equal(response.totalCost,usage.cost);
});

test('Unknown models are rejected without inference, missing costs are not fabricated',async()=>{
  await assert.rejects(chat({...params,model:'opencode/not-allowed'},{fetch:()=>assert.fail('unexpected request')}),/Unsupported/);
  assert.equal(openCodeCost({cost:0}),0);
  assert.equal(openCodeCost({}),null);
  assert.equal(openCodeCost({cost:-1}),null);
});
