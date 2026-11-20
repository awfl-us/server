import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseTypedToolCalls,validateSchema} from './typedToolArguments.js';
const schema={type:'object',additionalProperties:false,properties:{
  path:{type:'string'},maxLines:{type:'integer'},
  note:{oneOf:[{type:'string'},{type:'null'}]},
  tags:{oneOf:[{type:'array',items:{type:'string'}},{type:'null'}]},
  counts:{type:'object',additionalProperties:{type:'integer'}}
},required:['path','maxLines']};
const tools=[{type:'function',function:{name:'READ_TYPED',description:'Read source',parameters:schema}}];
const call=(args,name='READ_TYPED')=>({tool_calls:[{id:'call-1',type:'function',function:{name,arguments:args}}]});
const valid=JSON.stringify({path:'a.scala',maxLines:20,note:null,tags:['x'],counts:{a:1}});
test('typed tool args: lossless primitives, nullability, maps and optional omission',()=>{
  assert.deepEqual(parseTypedToolCalls(call(valid),tools)[0].arguments,JSON.parse(valid));
  assert.deepEqual(parseTypedToolCalls(call('{"path":"a","maxLines":3}'),tools)[0].arguments,{path:'a',maxLines:3});
});
test('typed tool args: reject malformed, missing, extra, wrong type and wrong function',()=>{
  for(const args of ['{', '{}', '{"path":"a","maxLines":2.5}',
    '{"path":"a","maxLines":2,"unexpected":1}',
    '{"path":"a","maxLines":2,"note":true}',
    '{"path":"a","maxLines":2,"counts":{"bad":"no"}}']) {
    assert.throws(()=>parseTypedToolCalls(call(args),tools),TypeError,args);
  }
  assert.throws(()=>parseTypedToolCalls(call(valid,'UNKNOWN'),tools),/Unknown/);
  assert.throws(()=>parseTypedToolCalls(call(valid),[...tools,...tools]),/unique/);
  assert.throws(()=>parseTypedToolCalls({tool_calls:[{type:'function',
    function:{name:'READ_TYPED',arguments:valid}}]},tools),/call id/);
  const one=call(valid).tool_calls[0];
  assert.throws(()=>parseTypedToolCalls({tool_calls:[one,{...one}]},tools),/duplicate typed tool call id/);
  assert.deepEqual(parseTypedToolCalls({content:'No tool'},tools),[]);
});
test('typed tool args: unsupported schemas fail closed',()=>{
  assert.throws(()=>validateSchema({type:'object',patternProperties:{}},{a:1}),/Unsupported schema keyword/);
  assert.throws(()=>validateSchema({type:'array'},[]),/missing items/);
  assert.deepEqual(validateSchema({type:'number'},Infinity),['$: expected number']);
  assert.deepEqual(validateSchema({oneOf:[{type:'string'},{type:'string'}]},'a'),
    ['$: expected exactly one matching variant (got 2)']);
});
test('typed tool arguments accept real enum constraints and reject invalid values',()=>{
  const toolsWithEnum = [{type:'function',function:{name:'READ_FILE',parameters:{
    type:'object',required:['filepath'],properties:{
      filepath:{type:'string'},encoding:{type:'string',enum:['utf-8','base64']}
    }
  }}}];
  const message = args => ({tool_calls:[{id:'call-read',type:'function',
    function:{name:'READ_FILE',arguments:JSON.stringify(args)}}]});
  assert.deepEqual(parseTypedToolCalls(message({filepath:'README.md'}),toolsWithEnum)[0].arguments,
    {filepath:'README.md'});
  assert.deepEqual(parseTypedToolCalls(message({filepath:'README.md',encoding:'utf-8'}),toolsWithEnum)[0].arguments,
    {filepath:'README.md',encoding:'utf-8'});
  assert.throws(()=>parseTypedToolCalls(message({filepath:'README.md',encoding:'invalid'}),toolsWithEnum),
    /allowed enum member/);
  assert.throws(()=>validateSchema({type:'string',enum:[]},'utf-8'),/Invalid enum schema/);
});
