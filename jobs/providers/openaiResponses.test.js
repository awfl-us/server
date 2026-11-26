import test from 'node:test';
import assert from 'node:assert/strict';
import { toResponsesInput, toResponsesTools, toResponsesToolChoice, toResponsesFormat, buildResponsesPayload, normalizeResponsesUsage, normalizeResponsesResult } from './openaiResponses.js';

function runConverterTests(test, assert) {
  const call = {id:'call_1',type:'function',function:{name:'read',arguments:'{"path":"a"}'}};
  const tool = {type:'function',function:{name:'read',parameters:{type:'object',properties:{path:{type:'string'}},required:[]}}};
  const usage = {input_tokens:100,output_tokens:12,total_tokens:112,input_tokens_details:{cached_tokens:80},output_tokens_details:{reasoning_tokens:5}};
  const item = {type:'function_call',id:'fc_not_call_id',call_id:'call_1',name:'read',arguments:'{"path":"a"}',status:'completed'};
  const reply = {type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Inspecting.'}]};
  test('ordered AWFL history becomes stateless Responses items with call_id linkage', () => {
    const payload=buildResponsesPayload({model:'gpt-6.1-terra',messages:[
      {role:'system',content:'Rules',docId:'d',create_time:12},
      {role:'user',content:'Read'},
      {role:'assistant',content:'Inspecting.',tool_calls:[call]},
      {role:'tool',tool_call_id:'call_1',content:'result'},
      {role:'user',content:'Continue'}
    ],tools:[tool],tool_choice:{type:'function',function:{name:'read'}},max_tokens:100,response_format:{type:'text'}},{reasoningEffort:'none'});
    assert.deepEqual(payload,{model:'gpt-6.1-terra',store:false,input:[
      {role:'system',content:'Rules'},{role:'user',content:'Read'},
      {role:'assistant',content:'Inspecting.'},{type:'function_call',call_id:'call_1',name:'read',arguments:'{"path":"a"}'},
      {type:'function_call_output',call_id:'call_1',output:'result'},{role:'user',content:'Continue'}
    ],tools:[{type:'function',name:'read',description:undefined,parameters:tool.function.parameters,strict:false}],
    tool_choice:{type:'function',name:'read'},max_output_tokens:100,text:{format:{type:'text'}},reasoning:{effort:'none'}});
  });
  test('tool-only history preserves calls and rejects invalid history',()=>{
    assert.deepEqual(toResponsesInput([{role:'assistant',content:null,tool_calls:[call]}]),[{type:'function_call',call_id:'call_1',name:'read',arguments:'{"path":"a"}'}]);
    assert.throws(()=>toResponsesInput([{role:'tool',content:'missing ID'}]));
    assert.throws(()=>toResponsesInput([{role:'user',content:[{type:'image_url'}]}]));
    assert.throws(()=>toResponsesInput([{role:'user',content:'x',tool_calls:[call]}]));
  });
  test('JSON formats, optional strictness, explicit temperature and no-tools payload',()=>{
    const p=buildResponsesPayload({model:'test',messages:[{role:'user',content:'JSON'}],tools:[],tool_choice:'auto',response_format:{type:'json_object'}},{temperature:0});
    assert.deepEqual(p,{model:'test',input:[{role:'user',content:'JSON'}],store:false,text:{format:{type:'json_object'}},temperature:0});
    assert.deepEqual(toResponsesFormat({type:'json_schema',json_schema:{name:'test',schema:{type:'object'},strict:true}}),{type:'json_schema',name:'test',schema:{type:'object'},strict:true});
    assert.equal(toResponsesTools([{...tool,function:{...tool.function,strict:true}}])[0].strict,true);
  });
  test('final text and multi-call output normalize to AWFL contract',()=>{
    const result=normalizeResponsesResult({status:'completed',usage,output:[reply,item,{...item,call_id:'call_2',name:'write',arguments:'{}'}]});
    assert.deepEqual(result,{message:{role:'assistant',content:'Inspecting.',tool_calls:[call,{id:'call_2',type:'function',function:{name:'write',arguments:'{}'}}]},usage:{prompt_tokens:100,completion_tokens:12,total_tokens:112,prompt_tokens_details:{cached_tokens:80},completion_tokens_details:{reasoning_tokens:5}}});
    assert.equal(normalizeResponsesResult({status:'completed',output:[item]}).message.content,null);
    assert.equal(normalizeResponsesResult({status:'completed',output:[reply]}).message.content,'Inspecting.');
  });
  test('incomplete, refused, duplicate and empty output cannot dispatch tools; billed usage retained',()=>{
    for(const response of [
      {status:'incomplete',output:[item]},
      {status:'completed',output:[item,{...reply,content:[{type:'refusal',refusal:'no'}]}]},
      {status:'completed',output:[item,item]},
      {status:'completed',output:[{...item,status:'in_progress'}]},
      {status:'completed',output:[]}
    ]){
      const result=normalizeResponsesResult({...response,usage});
      assert.equal(result.message,null);assert.ok(result.failure);assert.equal(result.usage.total_tokens,112);
    }
  });
}

runConverterTests(test, assert);
