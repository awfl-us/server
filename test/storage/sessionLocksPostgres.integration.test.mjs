/** Real Jobs /firebase session locks + isolated PostgreSQL, no cloud calls. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import express from 'express';
import pg from 'pg';
import {PostgresStorage} from '../../storage/postgres/storage.js';
import {createFirebaseDbRouter} from '../../jobs/firebaseDbApi.js';

const url=process.env.PGTEST_URL;
const enabled=Boolean(url);
if(enabled){
  const parsed=new URL(url);
  if(!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname) ||
    !['/awfl_reconcile','/benchmark_ci'].includes(parsed.pathname))
    throw new Error('Refusing non-isolated PostgreSQL URL');
}

test('session lock remains exclusive across concurrent requests and tool continuation',
  {skip:!enabled,timeout:25000}, async()=>{
  const pool=new pg.Pool({connectionString:url,max:14});
  const storage=new PostgresStorage({pool,ownPool:true});
  await storage.initialize();
  const app=express();
  app.use(express.json());
  app.use((req,_res,next)=>{req.userId='reconcile-user';req.projectId='reconcile-project';next();});
  app.use('/firebase',createFirebaseDbRouter({getStorage:()=>storage}));
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const endpoint='http://127.0.0.1:'+server.address().port;
  const root='sessionlocks_'+randomUUID().replaceAll('-','');
  const id='convo-session-1', other='convo-session-2', collection='locks.reconcile.'+root;
  const path=key=>`users/reconcile-user/projects/reconcile-project/${collection}/${key}`;
  const post=async(route,body)=>{
    const r=await fetch(endpoint+route,{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    return {status:r.status,body:await r.json()};
  };
  const lock=(key,owner,ttlSeconds=60)=>({collection,id:key,owner,ttlSeconds});
  const acquire=(key,owner,ttl=60)=>post('/firebase/locks/acquire',lock(key,owner,ttl));
  const release=(key,owner)=>post('/firebase/locks/release',{collection,id:key,owner});
  try{
    const owners=Array.from({length:12},(_,i)=>'request-'+i);
    const attempts=await Promise.all(owners.map(owner=>acquire(id,owner)));
    const winners=attempts.map((v,i)=>({v,owner:owners[i]})).filter(x=>x.v.status===200);
    assert.equal(winners.length,1,'same-session requests must never acquire concurrently');
    assert.equal(attempts.filter(x=>x.status===409).length,11);
    const winner=winners[0].owner;
    assert.equal((await storage.get(path(id))).data.owner,winner);
    // Another conversation in the same project should not be serialized
    // behind this session's slow/blocked tool callback.
    assert.equal((await acquire(other,'other-session')).status,200);
    const wrong=await release(id,'non-owner');
    assert.deepEqual(wrong,{status:200,body:{released:false}});
    assert.equal((await acquire(id,'another-request')).status,409,
      'wrong-owner release must not unlock pending tool continuation');
    assert.deepEqual(await release(id,winner),{status:200,body:{released:true}});
    const resumed=await acquire(id,'continuation',120);
    assert.equal(resumed.status,200,'lock should be available after required tool writes');
    assert.equal((await storage.get(path(id))).data.ttlSeconds,120);
    assert.equal((await release(id,winner)).body.released,false,
      'stale original owner cannot release continuation lock');
    assert.equal((await acquire(id,'third-turn')).status,409);

    // Simulate an expired owner with its original 1-second TTL, then verify
    // replacement takes the *new* owner TTL rather than inheriting 1 second.
    await storage.put(path(id),{created:Math.floor(Date.now()/1000)-10,
      owner:'expired',ttlSeconds:1});
    assert.equal((await acquire(id,'recovered-turn',100)).status,200);
    assert.equal((await storage.get(path(id))).data.ttlSeconds,100);
    assert.equal((await acquire(id,'competing-after-recovery')).status,409);
    assert.equal((await acquire(id,'invalid-ttl',0)).status,400);
    assert.equal((await acquire(id,'invalid-ttl',-1)).status,400);
    assert.equal((await acquire(id,'invalid-ttl',1.2)).status,400);
    assert.equal((await acquire(id,'invalid-ttl',3601)).status,400);
    console.log('POSTGRES_SESSION_LOCK_PASS',{requests:12,winners:1,otherSessionIndependent:true,
      staleOwnerFenced:true,expiredLeaseRecovered:true});
  }finally{
    await storage.delete(path(id)).catch(()=>{});
    await storage.delete(path(other)).catch(()=>{});
    await new Promise(resolve=>server.close(resolve));
    await storage.close();
  }
});
