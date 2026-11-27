import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createLlmRouter } from '../llm.js';
import publicModels from '../../workflows/llm.api.js';
import { OPENCODE_MODELS } from './opencodeModels.js';

test('Both catalogs match; OpenCode has separate credentials, allowlist and usage ledger',async()=>{
  const app=express(), keys=[], billed=[], seen=[];
  app.use(express.json());
  app.use((req,res,next)=>{req.userId='test';req.projectId='test-project';next();});
  const answer={message:{role:'assistant',content:'hello'},usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12},totalCost:0.00002};
  app.use('/jobs',createLlmRouter({
    apiKeyForUser:async(user,provider)=>{keys.push(provider);return provider==='opencode'?'mock':null;},
    adapters:{opencode:{chat:async(params)=>{seen.push(params);return answer;}}},
    recordUsage:async(entry)=>{billed.push(entry);}
  }));
  app.use('/public',publicModels);
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try {
    for(const route of ['/jobs/models','/public/models']){
      const catalog=await (await fetch(base+route)).json();
      assert.deepEqual(catalog.providers.find(p=>p.id==='opencode').examples,Object.keys(OPENCODE_MODELS));
      assert.ok(Object.keys(OPENCODE_MODELS).every(m=>catalog.known_models.includes(m)));
    }
    const post=async(model)=>fetch(base+'/jobs/chat',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({model,messages:[{role:'user',content:'hello'}]})});
    assert.equal((await post('opencode/unknown')).status,400);
    assert.equal(keys.length,0);
    assert.equal((await post('deepseek-chat')).status,400);
    assert.equal((await post('claude-3-5-sonnet')).status,400);
    const response=await post('opencode/claude-sonnet-5-5');
    assert.equal(response.status,200);
    assert.equal((await response.json()).total_cost,answer.totalCost);
    assert.deepEqual(keys,['deepseek','anthropic','opencode']);
    assert.equal(seen[0].apiKey,'mock');
    assert.equal(billed[0].totalCost,answer.totalCost);
    assert.equal(billed.length,1);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
