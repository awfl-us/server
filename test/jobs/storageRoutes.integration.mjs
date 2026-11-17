// Run with AWFL_STORAGE_INTEGRATION_BACKEND=firestore|postgres from an
// authorized development environment; writes isolated synthetic documents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import pg from 'pg';
import { Firestore } from '@google-cloud/firestore';
import { OAuth2Client, GoogleAuth } from 'google-auth-library';
import { readFile } from 'node:fs/promises';
import { createStorage } from '../../storage/factory.js';
import { createFirebaseDbRouter } from '../../jobs/firebaseDbApi.js';
import { createTasksRouter } from '../../workflows/tasks.js';
import { createNativeCallbackEffects, recordNativeCallbackDelivery } from '../../workflows/native/callbackEffects.js';

const backend=process.env.AWFL_STORAGE_INTEGRATION_BACKEND;
if (!['firestore','postgres'].includes(backend))throw Error('AWFL_STORAGE_INTEGRATION_BACKEND required');
const userId='awfl-test-'+randomUUID().replaceAll('-','');
const projectId='test';
const base=`users/${userId}/projects/${projectId}`;
let pool,db;
if (backend==='postgres'){
  pool=new pg.Pool({connectionString:process.env.AWFL_TEST_POSTGRES_URL,max:3,
    connectionTimeoutMillis:15000});
  await pool.query('SELECT 1');
}else{
  const token=(await readFile(process.env.CLOUDSDK_AUTH_ACCESS_TOKEN_FILE,'utf8')).trim();
  const oauth=new OAuth2Client();
  oauth.setCredentials({access_token:token,expiry_date:Date.now()+20*60_000});
  const auth=new GoogleAuth({projectId:'awfl-us'});auth.getClient=async()=>oauth;
  db=new Firestore({projectId:'awfl-us',auth});
}
const store=createStorage({backend,postgresPool:pool,firestoreDb:db});
const app=express();app.use(express.json());
app.use((req,_res,next)=>{req.userId=userId;req.projectId=projectId;next();});
app.use('/firebase',createFirebaseDbRouter({getStorage:async()=>store}));
app.use('/tasks',createTasksRouter({getStorage:async()=>store}));
const created=[];
const cleanup=async()=>{
  for(const id of created.reverse())await store.delete(id).catch(()=>{});
  await db?.terminate().catch(()=>{});await pool?.end().catch(()=>{});
};
process.on('exit',()=>{});
test(`Jobs generic Storage routes on real ${backend}`,async()=>{
  try {
    for(const [id,time] of [['a',100],['b',150],['c',200]]){
      const r=await request(app).post('/firebase/create').send({collection:'convo.sessions',id,
        contents:{create_time:time,title:id}});
      assert.equal(r.status,200,JSON.stringify(r.body));
      created.push(`${base}/convo.sessions/${id}`);
    }
    let r=await request(app).post('/firebase/create').send({collection:'convo.sessions',id:'a',contents:{title:'duplicate'}});
    assert.equal(r.status,409);
    r=await request(app).post('/firebase/read').send({collection:'convo.sessions',id:'a'});
    assert.equal(r.status,200);assert.equal(r.body.title,'a');
    r=await request(app).post('/firebase/update').send({collection:'convo.sessions',id:'a',contents:{title:'changed'}});
    assert.equal(r.status,200);
    r=await request(app).post('/firebase/read').send({collection:'convo.sessions',id:'a'});
    assert.equal(r.body.title,'changed');
    r=await request(app).post('/firebase/update').send({collection:'convo.sessions',id:'upsert',contents:{title:'created via update'}});
    assert.equal(r.status,200);
    created.push(`${base}/convo.sessions/upsert`);
    r=await request(app).post('/firebase/read').send({collection:'convo.sessions',id:'upsert'});
    assert.equal(r.body.title,'created via update');
    r=await request(app).post('/firebase/listAt').send({collection:'convo.sessions',at:150,before:2,after:2});
    assert.equal(r.status,200,JSON.stringify(r.body));
    assert.deepEqual(r.body.documents.map(d=>d.id),['a','b','c']);
    r=await request(app).post('/firebase/list').send({collection:'convo.sessions',start:100,end:200});
    assert.equal(r.status,200);assert.deepEqual(r.body.documents.map(d=>d.id),['b','c']);
    r=await request(app).post('/firebase/segmentsForSession').send({collection:'convo.sessions',windowSeconds:50,overlapSeconds:0});
    assert.equal(r.status,200);assert.equal(r.body.segments.length,3);
    r=await request(app).post('/firebase/locks/acquire').send({collection:'locks.test',id:'lock',owner:'runA'});
    assert.equal(r.status,200,JSON.stringify(r.body));created.push(`${base}/locks.test/lock`);
    r=await request(app).post('/firebase/locks/acquire').send({collection:'locks.test',id:'lock',owner:'runB'});
    assert.equal(r.status,409);
    r=await request(app).post('/firebase/locks/release').send({collection:'locks.test',id:'lock',owner:'runA'});
    assert.equal(r.status,200);
    r=await request(app).post('/firebase/locks/acquire').send({collection:'locks.test',id:'lock',owner:'runB'});
    assert.equal(r.status,200);

    r=await request(app).post('/tasks').send({sessionId:'s1',title:'Task',status:'Queued'});
    assert.equal(r.status,201,JSON.stringify(r.body));
    const task=r.body.task;created.push(`${base}/tasks/${task.id}`);
    r=await request(app).get('/tasks').query({sessionId:'s1'});
    assert.equal(r.status,200);assert.equal(r.body.tasks.length,1);
    r=await request(app).patch(`/tasks/${task.id}`).send({status:'Done'});
    assert.equal(r.status,200);assert.equal(r.body.task.status,'Done');
    r=await request(app).get('/tasks/by-session/s1');
    assert.equal(r.status,200);assert.equal(r.body.tasks[0].status,'Done');

    const callbacks=createNativeCallbackEffects({storage:store,jobsOrigin:'https://jobs.example.test'});
    const identity={userId,projectId};
    const exec='native_'+randomUUID().replaceAll('-','');
    const callback=await callbacks['callback.create']({args:{http_callback_method:'POST'},
      identity,idempotencyKey:exec+':call1'});
    const callbackId=callback.url.split('/').at(-1);
    created.push(`users/${userId}/callbacks/${callbackId}`);
    const wait=callbacks['callback.await']({args:{callback:{url:callback.url},timeout:10},identity});
    await new Promise(r=>setTimeout(r,400));
    assert.equal(await recordNativeCallbackDelivery({storage:store,
      ref:`users/${userId}/callbacks/${callbackId}`,body:{answer:'OK'},identity}),'recorded');
    assert.deepEqual(await wait,{http_request:{body:{answer:'OK'}}});
    console.log('JOB_STORAGE_PARITY_OK',backend,userId);
  } finally { await cleanup(); }
});
