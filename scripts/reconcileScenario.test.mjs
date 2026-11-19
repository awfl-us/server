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
