import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initializeApp, getApps } from 'firebase-admin/app';
import { Firestore } from '@google-cloud/firestore';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { readFile } from 'node:fs/promises';
import { getDocumentStorage, configureDocumentStorageClients } from '../../storage/service.js';
import { acquireConsumerLock, releaseConsumerLock, getConsumerLock,
  heartbeatConsumer, setConsumerRuntimeInfo } from '../../workflows/projects/lock.js';
import { registerWorkspace, resolveWorkspace } from '../../workflows/workspace/service.js';
import { projectPath } from '../../workflows/projects/util.js';
import { credentialStorageDb } from '../../storage/legacyBridge.js';
import { incrementUsage, getSessionTotals } from '../../jobs/llm/usage.js';
import { pickBackend } from '../../workflows/events/model.js';

if (!getApps().length) initializeApp();
let rawFirestore;
if ((process.env.AWFL_DOCUMENT_STORAGE_BACKEND||'firestore')==='firestore') {
  const token=(await readFile(process.env.CLOUDSDK_AUTH_ACCESS_TOKEN_FILE,'utf8')).trim();
  const oauth=new OAuth2Client();oauth.setCredentials({access_token:token,expiry_date:Date.now()+20*60_000});
  const auth=new GoogleAuth({projectId:'awfl-us'});auth.getClient=async()=>oauth;
  rawFirestore=new Firestore({projectId:'awfl-us',auth});
  configureDocumentStorageClients({firestoreDb:rawFirestore});
}
const backend=process.env.AWFL_DOCUMENT_STORAGE_BACKEND||'firestore';
const userId='storage-'+randomUUID().replaceAll('-','');
const projectId='project-'+randomUUID().replaceAll('-','');

test(`project lock and workspace Storage integration (${backend})`, async () => {
 const store=await getDocumentStorage(),path=projectPath(userId,projectId);
 const cleanup=[path];
 try {
  await store.create(path,{id:projectId,created:Date.now(),updated:Date.now()});
  let got=await acquireConsumerLock({userId,projectId,consumerId:'workerA',leaseMs:60000});
  assert.equal(got.ok,true);
  got=await acquireConsumerLock({userId,projectId,consumerId:'workerB',leaseMs:60000});
  assert.equal(got.conflict,true);
  got=await acquireConsumerLock({userId,projectId,consumerId:'workerA',leaseMs:60000});
  assert.equal(got.refreshed,true);
  got=await setConsumerRuntimeInfo({userId,projectId,consumerId:'workerA',
    runtime:{mode:'gke',imageProfile:'scala'}});
  assert.equal(got.ok,true);
  got=await heartbeatConsumer({userId,projectId,consumerId:'workerA',connected:true,
    capacity:4,activeExecutions:[],capabilities:['shell']});
  assert.equal(got.ok,true);
  const status=await getConsumerLock({userId,projectId});
  assert.equal(status.lock.consumerId,'workerA');
  assert.equal(status.lock.heartbeat.connected,true);
  assert.equal(status.lock.runtime.imageProfile,'scala');
  const db=await credentialStorageDb();
  const ref=db.collection('users').doc(userId).collection('projects').doc(projectId);
  assert.equal((await ref.get()).exists,true);
  const integration=ref.collection('integrations').doc('fakeCredential');
  cleanup.push(integration.path);
  await integration.set({installed:true,expires_at:new Date()});
  assert.equal((await integration.get()).data().installed,true);
  const tokenState=db.collection('testOauthStates').doc(randomUUID().replaceAll('-',''));
  cleanup.push(tokenState.path);
  await tokenState.create({value:'once'});
  const consumed=await db.runTransaction(async tx=>{
    const snap=await tx.get(tokenState);
    tx.delete(tokenState);
    return snap.data().value;
  });
  assert.equal(consumed,'once');
  assert.equal((await tokenState.get()).exists,false);
  const sessionId=randomUUID().replaceAll('-','');
  const now=Date.now();
  await incrementUsage({userId,projectId,sessionId,workflowName:'usageTest',
    usage:{total_tokens:25,prompt_tokens:20,completion_tokens:5},totalCost:0.25,timestamp:now});
  await incrementUsage({userId,projectId,sessionId,workflowName:'usageTest',
    usage:{total_tokens:25,prompt_tokens:20,completion_tokens:5},totalCost:0.25,timestamp:now});
  const totals=await getSessionTotals({userId,projectId,sessionId});
  assert.equal(totals.overall.requests,2);
  assert.equal(totals.overall.usage.total_tokens,50);
  assert.equal(totals.overall.total_cost,0.5);
  const hourKey=new Date(now).toISOString().slice(0,13).replace(/[-T]/g,'');
  cleanup.push(`users/${userId}/projects/${projectId}/convo.sessions/${sessionId}/llm.usage/usageTest__${hourKey}`);
  const relay=pickBackend(userId,projectId);
  const firstEvent={id:'evt'+randomUUID().replaceAll('-',''),projectId,sessionId:'session-test',
    create_time:new Date().toISOString(),type:'message',data:{answer:1}};
  await relay.append(firstEvent);
  cleanup.push(`users/${userId}/projects/${projectId}/relayEvents/${firstEvent.id}`,
    `users/${userId}/projects/${projectId}/relayEventsSessions/session-test/items/${firstEvent.id}`);
  assert.equal((await relay.recent('session-test',10)).at(-1).id,firstEvent.id);
  const after=await relay.replayProjectByUlid(firstEvent.id,10);
  assert.deepEqual(after,[]);
  const received=[];
  const stop=await relay.subscribeProject(ev=>received.push(ev),{after_time:firstEvent.create_time});
  try {
    const secondEvent={...firstEvent,id:'evt'+randomUUID().replaceAll('-',''),
      create_time:new Date(Date.now()+1000).toISOString(),data:{answer:2}};
    cleanup.push(`users/${userId}/projects/${projectId}/relayEvents/${secondEvent.id}`,
      `users/${userId}/projects/${projectId}/relayEventsSessions/session-test/items/${secondEvent.id}`);
    await relay.append(secondEvent);
    const deadline=Date.now()+6000;
    while(!received.some(e=>e.id===secondEvent.id)&&Date.now()<deadline)
      await new Promise(resolve=>setTimeout(resolve,100));
    assert.ok(received.some(e=>e.id===secondEvent.id),'project SSE stream must receive new event');
  } finally { await stop(); }
  const created=await registerWorkspace({userId,projectId});
  cleanup.push(`users/${userId}/projects/${projectId}/workspaces/${created.id}`);
  const resolved=await resolveWorkspace({userId,projectId});
  assert.equal(resolved.id,created.id);
  got=await releaseConsumerLock({userId,projectId,consumerId:'workerB'});
  assert.equal(got.conflict,true);
  got=await releaseConsumerLock({userId,projectId,consumerId:'workerA'});
  assert.equal(got.released,true);
  assert.equal((await getConsumerLock({userId,projectId})).lock,null);
  console.log('PROJECT_STORAGE_PARITY_OK',backend);
 } finally {
  for(const p of cleanup.reverse())await store.delete(p).catch(()=>{});
  await store.close();
  await rawFirestore?.terminate();
 }
});
