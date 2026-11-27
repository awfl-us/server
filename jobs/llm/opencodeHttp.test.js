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
    const response=await post('claude-sonnet-5-5');
    assert.equal(response.status,200);
    const body=await response.json();
    assert.equal(body.total_cost,answer.totalCost);
    assert.equal(body.provider,'opencode');
    assert.equal(body.model,'claude-sonnet-5-5');
    assert.deepEqual(keys,['opencode']);
    assert.equal(seen[0].model,'claude-sonnet-5-5');
    assert.equal(seen[0].apiKey,'mock');
    assert.equal(billed[0].totalCost,answer.totalCost);
    assert.equal(billed.length,1);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('HTTP routes a canonical model by price and credential, without exposing keys',async()=>{
  const app=express(), seen=[], billed=[];
  app.use(express.json());
  app.use((req,res,next)=>{req.userId='test';req.projectId='test-project';next();});
  let keys={opencode:'gateway-secret',deepseek:'direct-secret'};
  const usage={prompt_tokens:1000,completion_tokens:50,total_tokens:1050};
  const adapter=provider=>({chat:async(params)=>{
    seen.push({provider,model:params.model,apiKey:params.apiKey});
    return {message:{role:'assistant',content:'ok'},usage,...(provider==='opencode'?{totalCost:.000144}:{})};
  }});
  app.use(createLlmRouter({apiKeyForUser:async(_user,provider)=>keys[provider],
    adapters:{opencode:adapter('opencode'),deepseek:adapter('deepseek')},
    recordUsage:async entry=>{billed.push(entry);}}));
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const url='http://127.0.0.1:'+server.address().port+'/chat';
  const post=async(model)=>fetch(url,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({model,messages:[{role:'user',content:'hi'}]})});
  try {
    const a=await post('deepseek-v4.1-flash'), ab=await a.json();
    assert.equal(a.status,200);assert.equal(ab.provider,'opencode');assert.equal(ab.total_cost,.000144);
    assert.ok(!JSON.stringify(ab).includes('gateway-secret'));
    keys={deepseek:'direct-secret'};
    const b=await post('opencode/deepseek-v4.1-flash'), bb=await b.json();
    assert.equal(b.status,200);assert.equal(bb.provider,'deepseek');assert.equal(bb.model,'deepseek-v4.1-flash');
    assert.deepEqual(seen,[{provider:'opencode',model:'deepseek-v4.1-flash',apiKey:'gateway-secret'},
      {provider:'deepseek',model:'deepseek-flash',apiKey:'direct-secret'}]);
    assert.equal(billed.length,2);
    keys={};
    assert.equal((await post('deepseek-v4.1-flash')).status,400);
    assert.equal(seen.length,2);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
