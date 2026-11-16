import { test } from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import { PostgresStorage } from '../../storage/postgres/storage.js';
import { patch } from '../../storage/document/contract.js';

const enabled=Boolean(process.env.PGTEST_URL);
async function setup() {
  const {default:pg}=await import('pg');
  const pool=new pg.Pool({connectionString:process.env.PGTEST_URL,max:6});
  const storage=new PostgresStorage({pool,ownPool:true,pollIntervalMs:100});
  await storage.initialize();
  const id=randomUUID().replaceAll('-','');
  const root=`tests/${id}`;
  const collection=`${root}/cases`;
  return {storage,root,collection};
}

test('PostgreSQL: CRUD, hierarchical queries, batch and rollback are atomic', {skip:!enabled,timeout:30_000},async()=>{
  const {storage,root,collection}=await setup();
  const one=`${collection}/one`,two=`${collection}/two`;
  try {
    assert.equal(await storage.get(one),null);
    await storage.create(one,{status:'new',price:10, details:{visits:0}});
    await assert.rejects(()=>storage.create(one,{}),e=>e.code==='ALREADY_EXISTS');
    assert.deepEqual((await storage.get(one)).data,{status:'new',price:10, details:{visits:0}});
    await storage.update(one,{'details.visits':patch.increment(3),status:'done'});
    assert.equal((await storage.get(one)).revision,2);
    assert.deepEqual((await storage.get(one)).data,{status:'done',price:10,details:{visits:3}});
    await storage.batch([{op:'create',path:two,data:{status:'new',price:20}},
      {op:'put',path:`${collection}/three`,data:{status:'pending',price:30}}]);
    assert.equal(await storage.count({collection,where:[{field:'price',op:'>=',value:10}]}),3);
    const newest=await storage.query({collection,where:[{field:'status',op:'==',value:'new'}],limit:10});
    assert.deepEqual(newest.map(x=>x.id),['two']);
    const group=await storage.query({collectionGroup:'cases',where:[{field:'price',op:'>=',value:20}],limit:100});
    assert.deepEqual(group.filter(x=>x.path.startsWith(root)).map(x=>x.id).sort(),['three','two']);
    const pagination=await storage.query({collection,limit:2});
    assert.deepEqual(pagination.map(x=>x.id),['one','three']);
    const next=await storage.query({collection,startAfter:pagination.at(-1).path});
    assert.deepEqual(next.map(x=>x.id),['two']);
    assert.deepEqual(await storage.listCollections(root),['cases']);
    await assert.rejects(()=>storage.batch([{op:'create',path:`${collection}/four`,data:{}},
      {op:'create',path:one,data:{}}]),e=>e.code==='ALREADY_EXISTS');
    assert.equal(await storage.get(`${collection}/four`),null);
    await storage.delete(two);assert.equal(await storage.get(two),null);
    assert.deepEqual((await storage.query({collection})).map(x=>x.id),['one','three']);
  } finally { await storage.delete(one); await storage.delete(two); await storage.delete(`${collection}/three`); await storage.close(); }
});

test('PostgreSQL: concurrent counters serialize correctly', {skip:!enabled,timeout:30_000}, async()=>{
  const {storage,collection}=await setup();
  const doc=`${collection}/counter`;
  try {
    await storage.create(doc,{count:0});
    await Promise.all(Array.from({length:16},()=>storage.update(doc,{count:patch.increment(1)})));
    assert.equal((await storage.get(doc)).data.count,16);
    assert.equal((await storage.get(doc)).revision,17);
  } finally { await storage.delete(doc);await storage.close(); }
});

test('PostgreSQL: subscribe replays committed changes and deletion without polling gaps', {skip:!enabled,timeout:30_000},async()=>{
  const {storage,collection}=await setup();
  const doc=`${collection}/watched`;
  const events=[];
  let unsubscribe;
  try {
    unsubscribe=await storage.subscribe(doc,event=>events.push(event));
    assert.equal(events[0].type,'snapshot'); assert.equal(events[0].value,null);
    await storage.create(doc,{status:'ready'});
    await storage.update(doc,{status:'finished'});
    await storage.delete(doc);
    const deadline=Date.now()+7000;
    while (events.filter(x=>x.type==='change').length<3 && Date.now()<deadline) {
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    const changes=events.filter(x=>x.type==='change');
    assert.deepEqual(changes.map(x=>x.action),['create','update','delete']);
    assert.deepEqual(changes.map(x=>x.value?.data?.status),['ready','finished',undefined]);
    assert.equal(changes.at(-1).value,null);
    assert.ok(changes.every((x,i)=>i===0 || BigInt(x.cursor)>BigInt(changes[i-1].cursor)));
  } finally { await unsubscribe?.(); await storage.delete(doc);await storage.close(); }
});

test('PostgreSQL: one shared document store backs native memory-state fencing', {skip:!enabled,timeout:30_000},async()=>{
  const {storage,collection}=await setup();
  const {DocumentAtomicRecords}=await import('../../storage/document/atomicRecords.js');
  const {NativeMemoryExecutionPilotStore}=await import('../../storage/pilot/memoryExecutionState.js');
  const records=new DocumentAtomicRecords({storage,collection});
  const store=new NativeMemoryExecutionPilotStore({records});
  const id=`run_${randomUUID().replaceAll('-','')}`;
  try {
    await store.create({executionId:id,userId:'test-user',projectId:'test-project',
      workflowName:'Test',artifactSha256:'a'.repeat(64),input:{x:1},allowedOperations:[],
      protocolVersion:2});
    const claims=await Promise.allSettled(Array.from({length:8},(_,i)=>store.claim({
      executionId:id,workerId:`worker${i}`,leaseMs:30_000,
      expectedUserId:'test-user',expectedProjectId:'test-project',
    })));
    const successful=claims.filter(c=>c.status==='fulfilled');
    assert.equal(successful.length,1);
    assert.equal(claims.filter(c=>c.status==='rejected').length,7);
    const {owner,epoch}=successful[0].value;
    await store.complete({executionId:id,workerId:owner,epoch,result:{ok:true}});
    assert.deepEqual((await store.get(id)).result,{ok:true});
    assert.equal((await storage.get(`${collection}/${id}`)).data.status,'completed');
  } finally {await records.delete(id);await storage.close();}
});

test('PostgreSQL: another process can wake document and query listeners', {skip:!enabled,timeout:30_000},async()=>{
  const {storage:watcher,collection}=await setup();
  const {default:pg}=await import('pg');
  const otherPool=new pg.Pool({connectionString:process.env.PGTEST_URL,max:2});
  const writer=new PostgresStorage({pool:otherPool,ownPool:true});
  const doc=`${collection}/crossProcess`, documentEvents=[],queryEvents=[];
  let unsubscribeDoc,unsubscribeQuery;
  try {
    unsubscribeDoc=await watcher.subscribe(doc,e=>documentEvents.push(e));
    unsubscribeQuery=await watcher.subscribe({collection},e=>queryEvents.push(e));
    await writer.create(doc,{status:'waiting'});
    await writer.update(doc,{status:'done'});
    const deadline=Date.now()+8000;
    while ((documentEvents.filter(x=>x.type==='change').length<2 ||
      queryEvents.filter(x=>x.type==='change').length<2) && Date.now()<deadline) {
      await new Promise(resolve=>setTimeout(resolve,40));
    }
    const docChanges=documentEvents.filter(x=>x.type==='change');
    assert.deepEqual(docChanges.map(x=>x.value?.data?.status),['waiting','done']);
    assert.equal(queryEvents.filter(x=>x.type==='change').length,2);
    assert.equal((await watcher.query({collection}))[0].data.status,'done');
  } finally {
    await unsubscribeDoc?.();await unsubscribeQuery?.();
    await writer.delete(doc);await writer.close();await watcher.close();
  }
});

test('PostgreSQL: subscription can replay downtime events by committed cursor', {skip:!enabled,timeout:30_000},async()=>{
  const {storage,collection}=await setup();
  const path=`${collection}/resumable`;
  let unsub;
  try {
    const first=[];
    unsub=await storage.subscribe(path,e=>first.push(e));
    const position=first[0].cursor;
    await unsub();unsub=null;
    await storage.create(path,{value:1});
    await storage.update(path,{value:2});
    const replay=[];
    unsub=await storage.subscribe(path,e=>replay.push(e),{afterCursor:position});
    const deadline=Date.now()+5000;
    while(replay.filter(e=>e.type==='change').length<2 && Date.now()<deadline) {
      await new Promise(resolve=>setTimeout(resolve,30));
    }
    assert.deepEqual(replay.filter(e=>e.type==='change').map(e=>e.value.data.value),[1,2]);
    assert.equal(replay[0].type,'snapshot');
  }finally{await unsub?.();await storage.delete(path);await storage.close();}
});
