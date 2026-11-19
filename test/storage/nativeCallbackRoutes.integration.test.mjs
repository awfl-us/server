import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import express from 'express';
import pg from 'pg';
import {configureDocumentStorageClients,getDocumentStorage} from '../../storage/service.js';
import {createNativeCallbackEffects,recordNativeCallbackDelivery} from '../../workflows/native/callbackEffects.js';
import {PostgresStorage} from '../../storage/postgres/storage.js';

const enabled=Boolean(process.env.PGTEST_URL);
if (enabled) {
  const url=new URL(process.env.PGTEST_URL);
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) ||
      url.pathname!=='/awfl_reconcile' ||
      !['postgres:','postgresql:'].includes(url.protocol)) {
    throw new Error('Refusing callback test outside loopback /awfl_reconcile');
  }
}
const origin='https://jobs.example.org';

// Use real Jobs Express routes and one real PostgreSQL document backend. No
// Firebase, GCP, production callback endpoint, or in-memory storage doubles.
test('Jobs native callback route serializes duplicate deliveries and resumes PG waiters',
  {skip:!enabled,timeout:35000}, async()=>{
  process.env.AWFL_DOCUMENT_STORAGE_BACKEND='postgres';
  process.env.AWFL_NATIVE_DOCUMENT_STORE_ENABLED='1';
  process.env.AWFL_NATIVE_JOBS_URL=origin;
  const pool=new pg.Pool({connectionString:process.env.PGTEST_URL,max:12});
  // Only this opt-in isolated test DB is migrated; never run this on startup.
  await new PostgresStorage({pool}).initialize();
  configureDocumentStorageClients({postgresPool:pool});
  const storage=await getDocumentStorage();
  const {default:callbacks}=await import('../../workflows/callbacks/index.js');
  const {default:registration}=await import('../../jobs/callbacks/index.js');
  const app=express();
  let identity={userId:'cbtest_'+randomUUID().replaceAll('-',''),
    projectId:'project-a'};
  app.use((req,res,next)=>{ req.userId=req.headers['x-test-user']||identity.userId;
    req.projectId=req.headers['x-test-project']||identity.projectId; next();});
  app.use('/callbacks',callbacks);
  app.use('/jobs/callbacks',registration);
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const endpoint='http://127.0.0.1:'+server.address().port;
  const post=async(path,body,overrides={})=>{
    const response=await fetch(endpoint+path,{method:'POST',
      headers:{'content-type':'application/json',...(overrides.userId&&{'x-test-user':overrides.userId}),
        ...(overrides.projectId&&{'x-test-project':overrides.projectId})},
      body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  const effects=createNativeCallbackEffects({storage,jobsOrigin:origin});
  const make=async(ordinal)=>{
    const exec='native_'+randomUUID().replaceAll('-','');
    const create=await effects['callback.create']({args:{http_callback_method:'POST'},
      identity,idempotencyKey:exec+':create_'+ordinal});
    const repeated=await effects['callback.create']({args:{http_callback_method:'POST'},
      identity,idempotencyKey:exec+':create_'+ordinal});
    assert.deepEqual(repeated,create,'journal replay cannot create a new callback');
    const id=new URL(create.url).pathname.split('/').at(-1);
    const path='users/'+identity.userId+'/callbacks/'+id;
    assert.equal((await storage.get(path)).revision,1,'callback create must happen once');
    assert.deepEqual(await post('/jobs/callbacks',{callback_url:create.url}),
      {status:201,body:{id,callback_url:create.url}});
    assert.equal((await storage.get(path)).revision,1,'register must not rewrite callback');
    return {id,path,create};
  };
  const paths=[];
  try{
    const first=await make('first'); paths.push(first.path);
    // PostgreSQL LISTEN/NOTIFY is not assumed to be lossless: await must work
    // whether delivery was committed before or after the waiter subscribed.
    const waiter=effects['callback.await']({args:{callback:{url:first.create.url},timeout:8},identity});
    const payload={status:'ok',output:'read completed'};
    const concurrent=await Promise.all(Array.from({length:12},()=>
      post('/callbacks/'+first.id,payload)));
    assert.ok(concurrent.every(x=>x.status===200),JSON.stringify(concurrent));
    assert.equal(concurrent.filter(x=>x.body.recorded).length,1,
      'exactly one transaction commits callback delivery');
    assert.deepEqual(await waiter,{http_request:{body:payload}});
    assert.equal((await storage.get(first.path)).revision,2);
    assert.deepEqual(await post('/callbacks/'+first.id,payload),
      {status:200,body:{ok:true,recorded:false}});
    assert.equal((await storage.get(first.path)).revision,2);
    assert.equal((await post('/callbacks/'+first.id,{status:'wrong'})).status,409);
    assert.equal((await post('/callbacks/'+first.id,payload,{projectId:'project-b'})).status,403);
    assert.equal((await post('/callbacks/'+first.id,payload,{userId:'other-user'})).status,404);
    assert.deepEqual(await effects['callback.await']({
      args:{callback:{url:first.create.url},timeout:3},identity
    }),{http_request:{body:payload}});
    // A replacement process can observe the result with a fresh DB client,
    // without relying on an existing in-process subscription or cached state.
    const restartedPool=new pg.Pool({connectionString:process.env.PGTEST_URL,max:2});
    const restartedStorage=new PostgresStorage({pool:restartedPool,ownPool:true});
    try {
      const restartedEffects=createNativeCallbackEffects({storage:restartedStorage,jobsOrigin:origin});
      assert.deepEqual(await restartedEffects['callback.await']({
        args:{callback:{url:first.create.url},timeout:3},identity
      }),{http_request:{body:payload}});
    }finally{await restartedStorage.close();}

    const second=await make('second'); paths.push(second.path);
    // Simulate a process restart: use a separate Postgres client to commit
    // after the first process' waiter is subscribed.
    const independent=new pg.Pool({connectionString:process.env.PGTEST_URL,max:3});
    const writer=new PostgresStorage({pool:independent,ownPool:true,pollIntervalMs:60});
    try{
      const awaiting=effects['callback.await']({
        args:{callback:{url:second.create.url},timeout:8},identity
      });
      await new Promise(resolve=>setTimeout(resolve,90));
      assert.equal(await recordNativeCallbackDelivery({storage:writer,
        ref:second.path,body:{status:'done'},identity}),'recorded');
      assert.deepEqual(await awaiting,{http_request:{body:{status:'done'}}});
      assert.equal((await storage.get(second.path)).revision,2);
    }finally{await writer.close();}

    // Callback documents and auth scopes are independent across sessions.
    const third=await make('third');paths.push(third.path);
    assert.equal((await storage.get(third.path)).data.native_result_json,null);
    assert.equal((await post('/callbacks/'+third.id,[])).status,200);
    assert.equal((await storage.get(third.path)).revision,2);
    console.log('NATIVE_PG_CALLBACK_ROUTE_PASS',
      JSON.stringify({concurrentDeliveries:concurrent.length,recorded:1,
        duplicateRevision:2,crossPoolResume:true,authScope:true}));
  }finally{
    for(const path of paths) await storage.delete(path);
    await new Promise(resolve=>server.close(resolve));
    await storage.close();
    await pool.end();
  }
});
