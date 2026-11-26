import test from 'node:test';
import assert from 'node:assert/strict';
import { chat, useResponses } from './openai.js';

test('Responses canary is explicitly enabled per supported model', () => {
  assert.equal(useResponses('gpt-6.1-terra', ''), false);
  assert.equal(useResponses('gpt-6.1-terra', 'gpt-6-sol, gpt-6.1-terra'), true);
  assert.equal(useResponses('gpt-5.5', 'gpt-5.5'), false);
});

test('Responses SDK request and normalization preserve AWFL tool contract', async () => {
  const oldFetch = globalThis.fetch;
  const oldModels = process.env.AWFL_OPENAI_RESPONSES_MODELS;
  const requests = [];
  process.env.AWFL_OPENAI_RESPONSES_MODELS = 'gpt-6.1-terra';
  globalThis.fetch = async (url, init) => {
    requests.push({url:String(url), body:JSON.parse(init.body)});
    return new Response(JSON.stringify({
      id:'resp_test', model:'gpt-6.1-terra', status:'completed',
      output:[{type:'function_call',id:'fc_test',call_id:'call_test',name:'inspect',arguments:'{}',status:'completed'}],
      usage:{input_tokens:20,output_tokens:5,total_tokens:25,input_tokens_details:{cached_tokens:10},output_tokens_details:{reasoning_tokens:0}}
    }), {status:200,headers:{'content-type':'application/json'}});
  };
  try {
    const result=await chat({
      apiKey:'unit-test-placeholder', model:'gpt-6.1-terra', messages:[{role:'user',content:'Inspect'}],
      tools:[{type:'function',function:{name:'inspect',parameters:{type:'object',properties:{}}}}],
      tool_choice:'auto',max_tokens:100
    });
    assert.equal(requests.length,1);
    assert.ok(requests[0].url.endsWith('/v1/responses'));
    assert.equal(requests[0].body.store,false);
    assert.equal(requests[0].body.reasoning.effort,'none');
    assert.equal(requests[0].body.tools[0].strict,false);
    assert.equal(requests[0].body.max_output_tokens,100);
    assert.equal(result.message.tool_calls[0].id,'call_test');
    assert.equal(result.usage.prompt_tokens_details.cached_tokens,10);
    assert.equal(result.usage.total_tokens,25);
  } finally {
    globalThis.fetch=oldFetch;
    if (oldModels===undefined) delete process.env.AWFL_OPENAI_RESPONSES_MODELS;
    else process.env.AWFL_OPENAI_RESPONSES_MODELS=oldModels;
  }
});
