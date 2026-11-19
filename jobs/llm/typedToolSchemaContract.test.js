import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildChatPayload} from '../providers/openai.js';
import {parseTypedToolCalls} from './typedToolArguments.js';

const path=process.env.AWFL_TYPED_SCHEMA_FIXTURE_PATH;

test('Scala-generated typed tool JSON is losslessly forwarded to OpenAI and its arguments validated',
  {skip:!path},()=>{
  // Produced by JsonSchemaSpec with AWFL_TYPED_SCHEMA_FIXTURE_PATH; no
  // manually maintained duplicate of the Scala schema in this contract test.
  const tool=JSON.parse(readFileSync(path,'utf8'));
  assert.equal(tool.function.name,'READ_TYPED');
  assert.equal(tool.function.parameters.additionalProperties,false);
  const payload=buildChatPayload({model:'gpt-6.1-terra',messages:[{role:'user',content:'Read a file'}],
    tools:[tool],tool_choice:'auto',temperature:0.7,max_tokens:2048});
  assert.deepEqual(payload.tools,[tool]);
  assert.equal(payload.reasoning_effort,'none');
  const args={path:'src/main.scala',maxLines:100,history:[true,false],note:null,tags:['scala']};
  const message={role:'assistant',tool_calls:[{id:'call-1',type:'function',
    function:{name:'READ_TYPED',arguments:JSON.stringify(args)}}]};
  assert.deepEqual(parseTypedToolCalls(message,payload.tools),[
    {name:'READ_TYPED',id:'call-1',arguments:args}
  ]);
  const bad={...message,tool_calls:[{...message.tool_calls[0],function:{
    name:'READ_TYPED',arguments:JSON.stringify({...args,history:['wrong']})}}]};
  assert.throws(()=>parseTypedToolCalls(bad,payload.tools),/history\[0\]: expected boolean/);
  assert.throws(()=>parseTypedToolCalls({tool_calls:[{
    type:'function',function:{name:'READ_TYPED',arguments:JSON.stringify({...args,extra:1})}
  }]},payload.tools),/extra: unexpected property/);
});
