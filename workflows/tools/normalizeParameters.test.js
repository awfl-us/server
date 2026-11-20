import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeParameters} from './index.js';
import {parseTypedToolCalls} from '../../jobs/llm/typedToolArguments.js';

test('real tool listing normalizer omits invented empty enums and preserves genuine constraints',()=>{
  const parameters = normalizeParameters({type:'object',required:['filepath'],properties:{
    filepath:{type:'string'},
    max_bytes:{type:'number'},
    encoding:{type:'string',enum:['utf-8','base64']},
  }});
  assert.deepEqual(parameters.properties.filepath,{type:'string'});
  assert.deepEqual(parameters.properties.max_bytes,{type:'number'});
  assert.deepEqual(parameters.properties.encoding,{type:'string',enum:['utf-8','base64']});
  const tool={type:'function',function:{name:'READ_FILE',parameters}};
  const message=args=>({tool_calls:[{id:'call-1',type:'function',function:{
    name:'READ_FILE',arguments:JSON.stringify(args)
  }}]});
  const args={filepath:'README.md',max_bytes:4096};
  assert.deepEqual(parseTypedToolCalls(message(args),[tool])[0].arguments,args);
  assert.deepEqual(parseTypedToolCalls(message({...args,encoding:'base64'}),[tool])[0].arguments,
    {...args,encoding:'base64'});
  assert.throws(()=>parseTypedToolCalls(message({...args,encoding:'unknown'}),[tool]),
    /allowed enum member/);
});
