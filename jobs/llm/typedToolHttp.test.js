import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createLlmRouter} from '../llm.js';

const schema = {
  type: 'object',
  properties: {
    path: {type:'string'},
    count: {type:'integer'},
    note: {oneOf:[{type:'string'},{type:'null'}]}
  },
  required: ['path','count'],
  additionalProperties: false
};
const tool = {type:'function',function:{
  name:'READ_TYPED',description:'Read project files',parameters:schema
}};
const usage = {prompt_tokens:100,completion_tokens:20,total_tokens:120};
const valid = {path:'src/main.scala',count:2,note:null};

async function withRouter(responses, action) {
  const seen = [];
  const billed = [];
  let index = 0;
  const app = express();
  app.use(express.json());
  app.use((req,_res,next) => { req.userId='test-user'; req.projectId='test-project'; next(); });
  app.use('/llm',createLlmRouter({
    apiKeyForUser: async () => 'fake-test-key',
    adapters: {openai:{chat: async params => {
      seen.push(params);
      return {message:responses[Math.min(index++,responses.length-1)],usage};
    }}},
    recordUsage: async entry => {billed.push(entry);}
  }));
  const server = app.listen(0,'127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening',resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (body) => {
      const response=await fetch(base+'/llm/chat',{method:'POST',
        headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      return {status:response.status,body:await response.json()};
    };
    await action({post,seen,billed});
  } finally {
    await new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
  }
}

const request = {model:'gpt-6.1-terra',messages:[{role:'user',content:'read'}],
  tools:[tool],tool_choice:'auto',validate_tool_arguments:true,
  sessionId:'test-session',workflow_name:'helpers-TypedIstaSchemaFixture'};
const toolMessage = (args,name='READ_TYPED') => ({
  role:'assistant',tool_calls:[{id:'call-1',type:'function',
    function:{name,arguments:args}}]
});

test('real Jobs /llm/chat router forwards typed schema, accepts valid calls, and records usage',async()=>{
  await withRouter([toolMessage(JSON.stringify(valid))],async ({post,seen,billed})=>{
    const response=await post(request);
    assert.equal(response.status,200);
    assert.deepEqual(response.body.message.tool_calls[0].function.arguments,JSON.stringify(valid));
    assert.deepEqual(seen[0].tools,[tool]);
    assert.equal(seen[0].tool_choice,'auto');
    assert.ok(!('validate_tool_arguments' in seen[0]));
    assert.equal(billed.length,1);
    assert.equal(billed[0].sessionId,'test-session');
    assert.equal(billed[0].projectId,'test-project');
    assert.deepEqual(billed[0].usage,usage);
  });
});

test('real Jobs /llm/chat returns 422 after accounting for malformed or invalid typed calls',async()=>{
  const failures=[
    toolMessage('{invalid json'),
    toolMessage(JSON.stringify({...valid,count:'wrong'})),
    toolMessage(JSON.stringify({...valid,extra:'not allowed'})),
    toolMessage(JSON.stringify(valid),'UNKNOWN_TOOL'),
    {role:'assistant',tool_calls:[{type:'function',
      function:{name:'READ_TYPED',arguments:JSON.stringify(valid)}}]},
    {role:'assistant',tool_calls:[
      toolMessage(JSON.stringify(valid)).tool_calls[0],
      toolMessage(JSON.stringify(valid)).tool_calls[0]]}
  ];
  await withRouter(failures,async ({post,billed})=>{
    for (const [i] of failures.entries()) {
      const response=await post(request);
      assert.equal(response.status,422,`case ${i}`);
      assert.equal(response.body.error,'Typed tool arguments failed validation');
      assert.ok(response.body.reason);
      assert.ok(!JSON.stringify(response.body).includes('src/main.scala'),
        'raw tool arguments must not be returned');
    }
    assert.equal(billed.length,failures.length);
    assert.ok(billed.every(x=>x.usage.total_tokens===120));
  });
});

test('legacy Jobs /llm/chat remains unvalidated by default',async()=>{
  const malformed=toolMessage('{invalid json');
  await withRouter([malformed],async ({post,billed})=>{
    const response=await post({...request,validate_tool_arguments:false});
    assert.equal(response.status,200);
    assert.deepEqual(response.body.message,malformed);
    assert.equal(billed.length,1);
  });
});
