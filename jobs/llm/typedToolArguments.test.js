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
  assert.deepEqual(parseTypedToolCalls({content:'No tool'},tools),[]);
});
test('typed tool args: unsupported schemas fail closed',()=>{
  assert.throws(()=>validateSchema({type:'object',patternProperties:{}},{a:1}),/Unsupported schema keyword/);
  assert.throws(()=>validateSchema({type:'array'},[]),/missing items/);
  assert.deepEqual(validateSchema({type:'number'},Infinity),['$: expected number']);
  assert.deepEqual(validateSchema({oneOf:[{type:'string'},{type:'string'}]},'a'),
    ['$: expected exactly one matching variant (got 2)']);
});
