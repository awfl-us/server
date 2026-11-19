/**
 * Real compiled Rust + isolated PostgreSQL + loopback Jobs effect boundary.
 * PGTEST_URL must be a local `awfl_reconcile` database. No cloud credentials.
 * Memory-mode guarantees leases and completed replay, NOT per-effect journaling.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import pg from 'pg';
import {PostgresAtomicRecords} from '../storage/pilot/adapters/postgres.js';
import {NativeMemoryExecutionPilotStore} from '../storage/pilot/memoryExecutionState.js';
import {runNativeMemoryWorkflow} from '../workflows/native/memoryWorker.js';
import {localReleases,createLocalJobsHttpHandlers} from './nativeLocalDev.mjs';

const DB=process.env.PGTEST_URL;
const REPORT=process.env.AWFL_NATIVE_LOCAL_BUILD_REPORT;
const IDENTITY=Object.freeze({userId:'reconcile-user',projectId:'reconcile-project'});
const JOBS_ORIGIN='https://jobs-4wmfqir74q-uc.a.run.app';
function prerequisites() {
  if(!DB || !REPORT) return false;
  const url = new URL(DB);
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname) ||
     url.pathname !== '/awfl_reconcile' || !['postgres:','postgresql:'].includes(url.protocol)) {
    throw new Error('Refusing PostgreSQL tests outside loopback /awfl_reconcile');
  }
  return true;
}
const enabled=prerequisites();
async function makeStore() {
  const pool=new pg.Pool({connectionString:DB,max:6});
  const records=new PostgresAtomicRecords({pool,table:'reconcile_native_integration'});
  await records.initialize();
  return {records,store:new NativeMemoryExecutionPilotStore({records})};
}
async function createExecution(store,releases,id) {
  const root=await releases.active('helpers-ToolDefs');
  assert.ok(root,'helpers-ToolDefs must be compiled in native closure');
  await store.create({executionId:id,...IDENTITY,workflowName:'helpers-ToolDefs',
    artifactSha256:root.sha256,protocolVersion:2,
    allowedOperations:[...root.allowedOperations],
    streamIpcVersion:root.streamIpcVersion,
    trustedGlobalsVersion:root.trustedGlobalsVersion,
    input:{toolNames:['READ_FILE'],env:{...IDENTITY,sessionId:'reconcile-session',
      model:'gpt-6.1-terra',BASE_URL:JOBS_ORIGIN}}});
}
async function serveFixture() {
  const calls=[], accepted=new Map();
  const server=createServer((request,response)=>{
    const url=new URL(request.url,'http://localhost');
    calls.push({url:url.pathname,headers:request.headers,method:request.method});
    if(request.method!=='GET' || url.pathname!=='/tools/list' ||
        request.headers['x-user-id']!==IDENTITY.userId ||
        request.headers['x-project-id']!==IDENTITY.projectId) {
      response.writeHead(403);response.end(JSON.stringify({error:'rejected'}));return;
    }
    const key=request.headers['x-awfl-idempotency-key'];
    if(typeof key!=='string' || !key.startsWith('native_')) {
      response.writeHead(400);response.end(JSON.stringify({error:'missing idempotency key'}));return;
    }
    if(!accepted.has(key)) accepted.set(key,{items:[]});
    response.writeHead(200,{'content-type':'application/json'});
    response.end(JSON.stringify(accepted.get(key)));
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const port=server.address().port;
  const seen=[],missing=[],failedRequests=[];
  const handlers=createLocalJobsHttpHandlers({identity:IDENTITY,jobsOrigin:JOBS_ORIGIN,
    localJobsUrl:`http://127.0.0.1:${port}/`,seen,missing,failedRequests});
  return {server,calls,accepted,seen,missing,failedRequests,handlers,
    close:()=>new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()))};
}

function executionId() {return 'native_'+randomUUID().replaceAll('-','');}
const silent={reportEvent:()=>{},reportFailure:()=>{}};

test('native Rust workflow persists PostgreSQL result and replays without duplicate Jobs HTTP',
  {skip:!enabled,timeout:45_000},async()=>{
    const releases=await localReleases(REPORT), id=executionId();
    const db=await makeStore(), http=await serveFixture();
    try {
      await createExecution(db.store,releases,id);
      const options={store:db.store,releases,handlers:http.handlers,executionId:id,...IDENTITY};
      const output=await runNativeMemoryWorkflow(options);
      assert.deepEqual(output,{defs:[]});
      assert.equal((await db.store.get(id)).status,'completed');
      assert.equal(http.calls.length,1);
      // Open a second independent PostgreSQL pool, as a replacement process does.
      const restarted=await makeStore();
      try {
        assert.deepEqual(await runNativeMemoryWorkflow({...options,store:restarted.store}),output);
        assert.equal(http.calls.length,1,'completed workflow replay must not repeat HTTP');
        await assert.rejects(restarted.store.claim({executionId:id,workerId:'attacker',
          expectedProjectId:'wrong'}),/scope mismatch/);
      } finally {await restarted.records.close();}
      assert.deepEqual(http.missing,[]);
      assert.deepEqual(http.failedRequests,[]);
    }finally{await http.close();await db.records.delete(id);await db.records.close();}
});

test('SIGKILL of leased worker: new PostgreSQL connection recovers; old epoch fenced',
  {skip:!enabled,timeout:50_000},async()=>{
    const releases=await localReleases(REPORT),id=executionId();
    const db=await makeStore();let child;
    try {
      await createExecution(db.store,releases,id);
      child=spawn(process.execPath,['scripts/reconcilePgClaimChild.mjs'],{
        cwd:process.cwd(),env:{...process.env,AWFL_RECONCILE_CLAIM_WORKER:'1',
          RECONCILE_EXECUTION_ID:id},stdio:['ignore','pipe','pipe']});
      let output='';
      await new Promise((resolve,reject)=>{
        const limit=setTimeout(()=>reject(new Error('child failed to claim in time')),10_000);
        child.stdout.on('data',data=>{output+=data.toString();if(output.includes('AWFL_RECONCILE_CLAIMED')){
          clearTimeout(limit);resolve();}});
        child.once('error',e=>{clearTimeout(limit);reject(e)});
        child.once('exit',code=>{if(!output.includes('AWFL_RECONCILE_CLAIMED')){
          clearTimeout(limit);reject(new Error('claim child exited '+code));}});
      });
      const previous=JSON.parse(output.split('AWFL_RECONCILE_CLAIMED ')[1].split('\n')[0]);
      child.kill('SIGKILL'); await once(child,'exit');
      const before=await db.store.get(id);
      assert.equal(before.status,'running');
      assert.equal(before.owner,'crashed-worker');
      await new Promise(resolve=>setTimeout(resolve,1150));
      const resumed=await makeStore(), http=await serveFixture();
      try {
        const output=await runNativeMemoryWorkflow({store:resumed.store,releases,
          handlers:http.handlers,executionId:id,...IDENTITY});
        assert.deepEqual(output,{defs:[]});
        const state=await resumed.store.get(id);
        assert.equal(state.status,'completed');
        assert.equal(state.epoch,previous.epoch+1);
        assert.equal(http.calls.length,1);
        await assert.rejects(resumed.store.complete({executionId:id,workerId:'crashed-worker',
          epoch:previous.epoch,result:{stale:true},effectCount:0}),/stale memory execution/);
      }finally{await http.close();await resumed.records.close();}
    }finally{if(child && !child.killed) child.kill('SIGKILL');
      await db.records.delete(id);await db.records.close();}
});


test('crash after HTTP response: PostgreSQL restarts memory workflow; effect key stays stable',
  {skip:!enabled,timeout:45_000},async()=>{
    const releases=await localReleases(REPORT),id=executionId();
    const db=await makeStore(),http=await serveFixture();let child;
    try {
      await createExecution(db.store,releases,id);
      child=spawn(process.execPath,['scripts/reconcilePgEffectChild.mjs'],{
        cwd:process.cwd(),env:{...process.env,AWFL_RECONCILE_EFFECT_WORKER:'1',
          RECONCILE_EXECUTION_ID:id,RECONCILE_JOBS_URL:`http://127.0.0.1:${http.server.address().port}/`},
        stdio:['ignore','pipe','pipe']});
      let stdout='';
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('effect worker timeout: '+stdout)),12_000);
        child.stdout.on('data',data=>{
          stdout+=data.toString();
          if(stdout.includes('AWFL_RECONCILE_EFFECT_RESPONDED')){clearTimeout(timer);resolve();}
        });
        child.once('error',err=>{clearTimeout(timer);reject(err)});
        child.once('exit',code=>{
          if(!stdout.includes('AWFL_RECONCILE_EFFECT_RESPONDED')){
            clearTimeout(timer);reject(new Error('effect worker exited '+code));}
        });
      });
      assert.equal(http.calls.length,1);
      const key=http.calls[0].headers['x-awfl-idempotency-key'];
      child.kill('SIGKILL');await once(child,'exit');
      const crashed=await db.store.get(id);
      assert.equal(crashed.status,'running');
      // No 30-minute wall-clock wait: advance the recovered store's test clock
      // beyond the memory worker's 30-minute lease, preserving real SQL state.
      const reopened=await makeStore();
      const recovered=new NativeMemoryExecutionPilotStore({records:reopened.records,
        clock:()=>Date.now()+31*60*1000});
      try {
        const output=await runNativeMemoryWorkflow({store:recovered,releases,
          handlers:http.handlers,executionId:id,...IDENTITY});
        assert.deepEqual(output,{defs:[]});
        assert.equal((await recovered.get(id)).status,'completed');
        assert.equal(http.calls.length,2,'memory-mode replay resends unjournaled HTTP');
        assert.equal(http.calls[1].headers['x-awfl-idempotency-key'],key);
        assert.equal(http.accepted.size,1,'idempotent Jobs endpoint accepts one logical effect');
      }finally{await reopened.records.close();}
    }finally{if(child&&!child.killed)child.kill('SIGKILL');
      await http.close();await db.records.delete(id);await db.records.close();}
});
