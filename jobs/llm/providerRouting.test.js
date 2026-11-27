import test from 'node:test';
import assert from 'node:assert/strict';
import { candidatesFor, selectProvider } from './providerRouting.js';
import { canonicalModel } from './opencodeModels.js';
import { ratesFor } from './providerPricing.js';
import { resolveMaxTokens } from './modelConfig.js';

const request={messages:[{role:'user',content:'hello'}],maxCompletionTokens:1000};
const choose=(model,keys,extras={})=>selectProvider({model,request,
  now:new Date('2026-11-27T13:00:00Z'),apiKeyForUser:async p=>keys[p]||null,...extras});
test('canonical model names and legacy aliases produce the same routes and limits',()=>{
  assert.equal(canonicalModel('opencode/deepseek-v4.1-flash'),'deepseek-v4.1-flash');
  assert.deepEqual(candidatesFor('deepseek-flash'),candidatesFor('deepseek-v4.1-flash'));
  assert.deepEqual(candidatesFor('opencode/deepseek-v4.1-flash'),candidatesFor('deepseek-v4.1-flash'));
  assert.equal(resolveMaxTokens('opencode/deepseek-v4.1-flash'),resolveMaxTokens('deepseek-v4.1-flash'));
  assert.deepEqual(candidatesFor('opencode/unknown'),[]);
});
test('DeepSeek Flash uses cheaper OpenCode with both keys, direct otherwise',async()=>{
  assert.equal((await choose('deepseek-v4.1-flash',{opencode:'o',deepseek:'d'})).provider,'opencode');
  const d=await choose('deepseek-v4.1-flash',{deepseek:'d'});
  assert.equal(d.provider,'deepseek');
  assert.equal(d.upstreamModel,'deepseek-flash');
  assert.equal(d.apiKey,'d');
  assert.equal((await choose('deepseek-v4.1-flash',{opencode:'o'})).provider,'opencode');
  assert.equal(await choose('deepseek-v4.1-flash',{openai:'wrong'}),null);
});
test('DeepSeek Pro routes direct at both peak and off-peak for typical agent requests',async()=>{
  for(const now of [new Date('2026-11-27T13:00:00Z'),new Date('2026-11-27T02:00:00Z')]){
    assert.equal((await choose('deepseek-v4-pro',{opencode:'o',deepseek:'d'},{now})).provider,'deepseek');
  }
});
test('equal-priced GPT selects direct; gateway is used when direct key is absent',async()=>{
  assert.equal((await choose('gpt-6.2-sol',{openai:'a',opencode:'o'})).provider,'openai');
  assert.equal((await choose('gpt-6.2-sol',{opencode:'o'})).provider,'opencode');
  assert.equal((await choose('gpt-5',{openai:'a',opencode:'o'})).provider,'opencode');
});
test('tool and structured requests exclude text-only direct adapters',async()=>{
  const keys={opencode:'o',anthropic:'a',gemini:'g'};
  assert.equal((await choose('claude-sonnet-5-5',keys)).provider,'anthropic');
  const tools=[{type:'function',function:{name:'test',parameters:{}}}];
  assert.equal((await choose('claude-sonnet-5-5',keys,{request:{...request,tools}})).provider,'opencode');
  assert.equal(await choose('gemini-4-argon',{gemini:'g'},{request:{...request,tools}}),null);
  assert.equal((await choose('gemini-4-argon',keys,{request:{...request,response_format:{type:'json_object'}}})).provider,'opencode');
});
test('date-dependent and long-context rates are applied to both providers',()=>{
  assert.equal(ratesFor('deepseek','deepseek-v4.1-flash',{now:new Date('2026-11-27T02:00:00Z')}).prompt,.3);
  assert.equal(ratesFor('deepseek','deepseek-v4.1-flash',{now:new Date('2026-11-28T02:00:00Z')}).prompt,.15);
  assert.equal(ratesFor('openai','gpt-6.2-sol',{inputTokens:272001}).prompt,4);
  assert.equal(ratesFor('opencode','gemini-4-argon',{now:new Date('2026-12-01')}).prompt,4);
});
test('single-provider legacy routes stay unchanged',async()=>{
  assert.equal((await choose('gpt-6.1-terra',{openai:'a',opencode:'o'})).provider,'openai');
  assert.equal(await choose('gpt-6.1-terra',{opencode:'o'}),null);
  assert.equal((await choose('glm-5.3',{opencode:'o',openai:'a'})).provider,'opencode');
});
