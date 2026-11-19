import assert from 'node:assert/strict';
import {test} from 'node:test';
import {makeReconciliationFixture} from './reconcileScenario.mjs';

const invoke=(fixture,path,body={},method='POST')=>fixture.respond({method,path,args:{body},effectId:'fixture-id'});

test('fixture stores user messages with one id; duplicates return 409',()=>{
  const f=makeReconciliationFixture();
  const msg={collection:'convo.sessions/reconcile-session/messages',id:'123',contents:{
    create_time:100,value:{role:'user',content:'hello'}}};
  assert.equal(invoke(f,'/firebase/create',msg).code,200);
  assert.equal(invoke(f,'/firebase/create',msg).code,409);
  assert.deepEqual(f.messages().map(x=>x.value.content),['hello']);
  assert.equal(invoke(f,'/firebase/read',msg).body.value.content,'hello');
  assert.equal(invoke(f,'/firebase/locks/acquire',{owner:'x'}).body.acquired,true);
  assert.equal(invoke(f,'/firebase/locks/release',{}).body.released,true);
});

test('LLM receives real assembled messages; model response is deterministic',()=>{
  const f=makeReconciliationFixture();
  const args={messages:[{role:'system',content:'stable'},{role:'user',content:'hello'}]};
  const result=invoke(f,'/llm/chat',args).body;
  assert.equal(result.message.role,'assistant');
  assert.equal(result.total_cost,0);
  assert.equal(f.modelRequests.length,1);
  assert.deepEqual(f.modelRequests[0].messages,args.messages);
});

test('all unexpected Jobs endpoints fail closed instead of silently returning success',()=>{
  const f=makeReconciliationFixture();
  assert.throws(()=>invoke(f,'/firebase/write-anything',{foo:'bar'}),/Unmocked AWFL endpoint/);
  assert.throws(()=>invoke(f,'/llm/other',{}),/Unmocked AWFL endpoint/);
});

test('no-query scenario seeds one previous user message, not a new synthetic one',()=>{
  const f=makeReconciliationFixture({scenario:'no-query'});
  assert.deepEqual(f.messages().map(x=>x.value.role),['user']);
  assert.deepEqual(invoke(f,'/context/topicContextYoj/run',{}).body.yoj.map(x=>x.role),['user']);
});

test('recorded and dynamic fixture handlers are isolated from production services',()=>{
  const f=makeReconciliationFixture();
  assert.equal(invoke(f,'/firebase/list',{collection:'convo.sessions/reconcile-session/messages',start:0,end:1000}).body.documents.length,0);
  assert.equal(invoke(f,'/agents/session/reconcile-session',{},'GET').body.agentId,'default');
  assert.deepEqual(invoke(f,'/agents/default/tools',{},'GET').body.tools,[]);
  assert.deepEqual(invoke(f,'/firebase/segmentsForSession',{windowSeconds:1200}).body.segments.length,1);
});


test('tool roundtrip registers a semantic READ_FILE tool and correlates callback IDs',async()=>{
  const f=makeReconciliationFixture({scenario:'tool-roundtrip'});
  assert.deepEqual(invoke(f,'/agents/default/tools',{},'GET').body.tools,['READ_FILE']);
  assert.equal(invoke(f,'/tools/list',{},'GET').body.items[0].function.name,'READ_FILE');
  const call=f.callbackCreate();
  const created=await call;
  const callbackId=new URL(created.url).pathname.split('/').at(-1);
  assert.equal(invoke(f,'/callbacks',{callback_url:created.url}).body.id,callbackId);
  invoke(f,'/events',{data:{callback_id:callbackId,tool_call:{function:{name:'READ_FILE'}}}});
  const result=await f.callbackAwait({args:{callback:created}});
  assert.equal(result.http_request.body.content,'{"debug":true}');
  assert.equal(result.http_request.body.filepath,'/tmp/reconcile-config.json');
  assert.equal(invoke(f,'/llm/chat',{messages:[]}).body.message.tool_calls[0].id,'read-fixture-1');
  assert.equal(invoke(f,'/llm/chat',{messages:[]}).body.message.role,'assistant');
});

test('unknown callback identity is rejected rather than generating a fake tool result',async()=>{
  const f=makeReconciliationFixture({scenario:'tool-roundtrip'});
  await assert.rejects(f.callbackAwait({args:{callback:{url:'https://jobs-4wmfqir74q-uc.a.run.app/callbacks/unknown'}}}),/No tool registered/);
});


test('background summaries and topic extraction receive deterministic valid JSON without consuming foreground turns', () => {
  const fixture=makeReconciliationFixture({scenario:'tool-roundtrip'});
  const background = [
    ['context-ContextCollapser-SegKala',{groups:[]}],
    ['Summaries-Convo',{title:'Fixture conversation',summary:'Read-only configuration discussion.'}],
    ['assistant-ExtractTopics-Convo',{topics:[],nuggets:[],reflections:[],artifacts:[],shouldSaveReflection:false}],
  ];
  for (const [workflow_name,expected] of background) {
    const body={workflow_name,response_format:{type:'json_object'},messages:[]};
    const response=fixture.respond({method:'POST',path:'/llm/chat',args:{body},effectId:workflow_name});
    assert.deepEqual(JSON.parse(response.body.message.content),expected);
  }
  const foreground=fixture.respond({method:'POST',path:'/llm/chat',args:{body:{messages:[],response_format:{type:'text'}}},effectId:'foreground'});
  assert.equal(foreground.body.message.tool_calls[0].function.name,'READ_FILE');
  assert.throws(()=>fixture.respond({method:'POST',path:'/llm/chat',args:{body:{workflow_name:'unknown',response_format:{type:'json_object'},messages:[]}},effectId:'bad'}),/Unmocked JSON completion/);
});
