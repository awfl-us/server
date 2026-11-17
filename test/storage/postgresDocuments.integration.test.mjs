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

async function until(predicate,timeoutMs=7000) {
  const deadline=Date.now()+timeoutMs;
  while (!predicate() && Date.now()<deadline) await new Promise(r=>setTimeout(r,25));
  assert.ok(predicate(),'timed out waiting for subscription');
}

test('PostgreSQL: document subscriptions observe current state without global cursors',
  {skip:!enabled,timeout:30_000},async()=>{
  const {storage,collection}=await setup();
  const path=`${collection}/watched`,events=[];
  let unsubscribe;
  try {
    unsubscribe=await storage.subscribe(path,e=>events.push(e));
    assert.equal(events[0].type,'snapshot');
    assert.equal(events[0].value,null);
    await storage.create(path,{status:'ready'});
    await until(()=>events.some(e=>e.type==='change' && e.value?.data?.status==='ready'));
    await storage.update(path,{status:'finished'});
    await until(()=>events.some(e=>e.type==='change' && e.value?.data?.status==='finished'));
    await storage.delete(path);
    await until(()=>events.some(e=>e.type==='change' && e.value===null));
    assert.deepEqual(events.filter(e=>e.type==='change').map(e=>e.action),
      ['create','update','delete']);
    await assert.rejects(()=>storage.subscribe(path,()=>{},{afterCursor:'0'}),
      e=>e.code==='UNSUPPORTED');
  }finally{await unsubscribe?.();await storage.delete(path);await storage.close();}
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

test('PostgreSQL: cross-process notifications refresh document and query watches',
  {skip:!enabled,timeout:30_000},async()=>{
  const {storage:watcher,collection}=await setup();
  const {default:pg}=await import('pg');
  const writer=new PostgresStorage({pool:new pg.Pool({connectionString:process.env.PGTEST_URL,max:2}),ownPool:true});
  const path=`${collection}/crossProcess`,documentEvents=[],queryEvents=[];
  let unsubscribeDoc,unsubscribeQuery;
  try {
    unsubscribeDoc=await watcher.subscribe(path,e=>documentEvents.push(e));
    unsubscribeQuery=await watcher.subscribe({collection},e=>queryEvents.push(e));
    await writer.create(path,{status:'waiting'});
    await until(()=>documentEvents.some(e=>e.value?.data?.status==='waiting'));
    await writer.update(path,{status:'done'});
    await until(()=>documentEvents.some(e=>e.value?.data?.status==='done'));
    await until(()=>queryEvents.some(e=>e.type==='change' &&
      e.value?.some(doc=>doc.data.status==='done')));
    assert.equal((await watcher.query({collection}))[0].data.status,'done');
  }finally {
    await unsubscribeDoc?.();await unsubscribeQuery?.();
    await writer.delete(path);await writer.close();await watcher.close();
  }
});

test('PostgreSQL: session event streams replay disconnects and deduplicate append IDs',
  {skip:!enabled,timeout:30_000},async()=>{
  const {storage,root}=await setup();
  const target={scope:'session',streamId:root.replaceAll('/','_')};
  const first=[];
  let unsubscribe;
  try {
    unsubscribe=await storage.subscribeEvents(target,e=>first.push(e),{afterCursor:'0'});
    const one=await storage.appendEvent({...target,eventId:'one',payload:{message:'one'}});
    await until(()=>first.filter(e=>e.type==='event').length===1);
    assert.equal(one.cursor,'1');
    assert.equal(one.duplicate,false);
    const duplicate=await storage.appendEvent({...target,eventId:'one',payload:{message:'one'}});
    assert.deepEqual(duplicate,{cursor:'1',duplicate:true});
    await unsubscribe();unsubscribe=null;
    await storage.appendEvent({...target,eventId:'two',payload:{message:'two'}});
    await storage.appendEvent({...target,eventId:'three',payload:{message:'three'}});
    const replay=[];
    unsubscribe=await storage.subscribeEvents(target,e=>replay.push(e),{afterCursor:one.cursor});
    await until(()=>replay.filter(e=>e.type==='event').length===2);
    assert.deepEqual(replay.map(e=>e.id),['two','three']);
    assert.deepEqual(replay.map(e=>e.cursor),['2','3']);
  }finally{await unsubscribe?.();await storage.close();}
});

test('PostgreSQL: concurrent session and project event cursors are independent',
  {skip:!enabled,timeout:30_000},async()=>{
  const {storage,root}=await setup();
  const scopes=[{scope:'session',streamId:root.replaceAll('/','_')+'_sessionA'},
    {scope:'session',streamId:root.replaceAll('/','_')+'_sessionB'},
    {scope:'project',streamId:root.replaceAll('/','_')+'_project'}];
  try {
    const results=await Promise.all(scopes.map(async target=>
      Promise.all(Array.from({length:12},(_,i)=>
        storage.appendEvent({...target,eventId:String(i),payload:{i}})))));
    // Ordering of concurrent appends is unspecified across callers, but
    // every individual stream allocates a gap-free, 1-based position.
    for(let i=0;i<scopes.length;i++){
      assert.deepEqual(results[i].map(e=>BigInt(e.cursor)).sort((a,b)=>Number(a-b)),
        Array.from({length:12},(_,n)=>BigInt(n+1)));
      const replay=await storage.replayEvents({...scopes[i],afterCursor:'0'});
      assert.equal(replay.length,12);
      assert.deepEqual(replay.map(e=>e.cursor),
        Array.from({length:12},(_,n)=>String(n+1)));
    }
  }finally{await storage.close();}
});

test('PostgreSQL: legacy API compatibility facade reads, filters, updates and paginates on same DB',
  {skip:!enabled,timeout:30_000}, async()=>{
    const {storage,root,collection}=await setup();
    const {StorageCompatFirestore}=await import('../../storage/legacyBridge.js');
    const facade=new StorageCompatFirestore(storage), col=facade.collection(collection);
    const first=col.doc('first'), second=col.doc('second'), third=col.doc('third');
    try {
      await first.set({created:1,status:'pending',visits:0});
      await second.set({created:2,status:'ready',visits:0});
      await third.set({created:3,status:'ready',visits:0});
      const paged=await col.where('status','==','ready')
        .orderBy('created','desc').limit(1).get();
      assert.equal(paged.docs.length,1);
      assert.equal(paged.docs[0].id,'third');
      assert.equal((await col.where('status','==','ready').count().get()).data().count,2);
      const all=await col.get();
      assert.deepEqual(all.docs.map(d=>d.id),['first','second','third']);
      assert.deepEqual((await first.get()).data(),{created:1,status:'pending',visits:0});
      await facade.runTransaction(async tx=>{
        const snap=await tx.get(first);
        assert.equal(snap.get('status'),'pending');
        tx.update(first,{visits:4});
      });
      assert.equal((await first.get()).data().visits,4);
      assert.deepEqual((await facade.doc(root).listCollections()).map(x=>x.id),['cases']);
    } finally {
      await storage.delete(first.path);
      await storage.delete(second.path);
      await storage.delete(third.path);
      await storage.close();
    }
  });

test('PostgreSQL: indexed subcollection lookup excludes adjacent and wildcard parent paths',
  {skip:!enabled,timeout:30_000},async()=>{
    const {storage,collection}=await setup();
    const parents=[
      collection+'/prefix',
      collection+'/prefix0',
      collection+'/prefix%_',
      collection+'/prefix-other',
    ];
    const paths=[
      parents[0]+'/children/one',
      parents[0]+'/extra/two',
      parents[1]+'/other/three',
      parents[2]+'/literal/four',
      parents[3]+'/not-matching/five',
    ];
    try{
      const index=await storage.pool.query(\"SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='awfl_documents_collection_path_pattern'\");
      assert.match(index.rows[0]?.indexdef || '',/text_pattern_ops/);
      for(const path of paths) await storage.create(path,{ok:true});
      assert.deepEqual(await storage.listCollections(parents[0]),['children','extra']);
      assert.deepEqual(await storage.listCollections(parents[1]),['other']);
      assert.deepEqual(await storage.listCollections(parents[2]),['literal']);
      assert.deepEqual(await storage.listCollections(parents[3]),['not-matching']);
    } finally {
      for(const path of paths) await storage.delete(path);
      await storage.close();
    }
  });
