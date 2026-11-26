import {test} from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomBytes,randomUUID} from 'node:crypto';
import {authorizeResponseScope} from './liveResponseScope.js';
import {snapshotParts} from './responseSnapshots.js';
import {encodeLiveEvent} from './postgresLiveBus.js';

import {scope,fixtureStorage,mockHub,appFor,runLiveScenario,wait} from './liveResponseTestFixture.js';

test('scope authorization rejects cross-project and path injection without legacy fallback',async()=>{
  const storage=fixtureStorage();
  assert.equal(await authorizeResponseScope(scope,storage),true);
  assert.equal(await authorizeResponseScope({...scope,sessionId:'other'},storage),true);
  for(const extra of [{projectId:'bad'},{userId:'foreign'},{sessionId:'missing'},{sessionId:'../s'},{sessionId:'..'},{projectId:['p']}])
    assert.equal(await authorizeResponseScope({...scope,...extra},storage),false);
  assert.ok(storage.reads.every(x=>!x.includes('/../')));
});
test('SSE rejects missing auth, invalid/foreign session and disabled transport before subscribing',async()=>{
  const hub=mockHub(),storage=fixtureStorage(),app=appFor(hub.make(),storage);
  assert.equal((await request(app).get('/responses/stream?sessionId=s').set('x-project-id','p')).status,401);
  assert.equal((await request(app).get('/responses/stream?sessionId=missing').set('x-project-id','p').set('x-test-user','u')).status,404);
  assert.equal((await request(app).get('/responses/stream?sessionId=s').set('x-project-id','p').set('x-test-user','foreign')).status,404);
  assert.equal((await request(app).get('/responses/stream?sessionId=..%2Fs').set('x-project-id','p').set('x-test-user','u')).status,400);
  assert.equal((await request(appFor(null,storage)).get('/responses/stream?sessionId=s').set('x-project-id','p').set('x-test-user','u')).status,503);
  await wait(()=>hub.count===0);
});
test('snapshot fragmentation preserves Unicode and keeps encrypted frames below notification limit',()=>{
  const content='🌍\n"\\\u0000'.repeat(3000);
  const parts=snapshotParts(content);assert.equal(parts.join(''),content);
  for(const [index,part] of parts.entries())encodeLiveEvent({scope:{userId:'u'.repeat(256),projectId:'p'.repeat(256),sessionId:'s'.repeat(256)},responseId:randomUUID(),attemptId:randomUUID(),sequence:999,type:'response.snapshot',data:{requestId:randomUUID(),index,count:parts.length,content:part,status:'response.delta'}},randomBytes(32));
});
test('two API listeners recover a live response, forward deltas and revoke membership', {timeout:12000},async()=>{
  const hub=mockHub();await runLiveScenario({producerBus:hub.make(),apiBus1:hub.make(),apiBus2:hub.make()});
  await wait(()=>hub.count===0);
});

import {getLiveResponseComponents,createConfiguredResponseStream} from './liveResponseService.js';
import {createPostgresConnectionOptions} from '../../storage/nativeMemory.js';
test('live composition is off by default and shared connection options retain local and IAM guards',async()=>{
  const old=process.env.AWFL_LIVE_RESPONSES_ENABLED;
  try{delete process.env.AWFL_LIVE_RESPONSES_ENABLED;
    assert.equal(await getLiveResponseComponents(),null);
    assert.equal(await createConfiguredResponseStream({scope}),null);
    assert.deepEqual(await createPostgresConnectionOptions({AWFL_POSTGRES_URL:'postgres://localhost/test'}),{options:{connectionString:'postgres://localhost/test'},connector:null});
    await assert.rejects(createPostgresConnectionOptions({AWFL_CLOUD_SQL_INSTANCE:'fixture',PGHOST:'localhost'}),/mutually exclusive/);
  }finally{if(old===undefined)delete process.env.AWFL_LIVE_RESPONSES_ENABLED;else process.env.AWFL_LIVE_RESPONSES_ENABLED=old;}
});
