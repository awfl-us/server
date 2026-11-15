import test from 'node:test';
import assert from 'node:assert/strict';
import { FirestoreAtomicRecords } from '../../storage/pilot/adapters/firestore.js';
import { RealtimeAtomicRecords } from '../../storage/pilot/adapters/realtime.js';
import { PostgresAtomicRecords } from '../../storage/pilot/adapters/postgres.js';
import { NativeMemoryExecutionPilotStore } from '../../storage/pilot/memoryExecutionState.js';
import { RecordConflictError } from '../../storage/pilot/contract.js';

const stored = new Map();
function fireDb() {
  const records = new Map();
  const doc = key => ({
    async get() { return snapshot(records.get(key)); },
    async create(x) { if (records.has(key)) throw { code: 6 }; records.set(key, structuredClone(x)); },
    async set(x) { records.set(key, structuredClone(x)); },
    async delete() { records.delete(key); },
  });
  const snapshot = x => ({ exists: x !== undefined, data: () => structuredClone(x) });
  const db = { collection: () => ({ doc }),
    async runTransaction(fn) {
      const writes = [];
      const tx = { get: x => x.get(), set: (ref,value) => writes.push([ref, value]) };
      const result = await fn(tx);
      for (const [ref,value] of writes) await ref.set(value);
      return result;
    } };
  return new FirestoreAtomicRecords({db});
}
function realtimeDb() {
  const values = new Map(); const revisions = new Map();
  const fetchImpl = async (url, opts) => {
    const key = url.split('/').at(-1).replace(/\.json$/, '');
    const value = values.has(key) ? structuredClone(values.get(key)) : null;
    const etag = revisions.has(key) ? `"${revisions.get(key)}"` : 'null_etag';
    const ifMatch = opts.headers['if-match'];
    let status = 200, output = value;
    if (opts.method === 'PUT') {
      if (ifMatch && ifMatch !== etag) status = 412;
      else { output = JSON.parse(opts.body); values.set(key, output); revisions.set(key, (revisions.get(key) || 0) + 1); }
    } else if (opts.method === 'DELETE') { values.delete(key); revisions.set(key, (revisions.get(key) || 0) + 1); output = null; }
    return { status, headers: { get: h => h==='etag' ? etag : null }, text: async () => JSON.stringify(output) };
  };
  return new RealtimeAtomicRecords({databaseURL:'https://example.firebaseio.com',tokenProvider:async()=> 'fake', fetchImpl});
}
// SQL-aware in-memory pool exercising pg's command and transaction sequencing.
// Not a substitute for the live Cloud SQL PostgreSQL benchmark.
function fakePgPool() {
  const records = new Map();
  const query = async (sql, values = []) => {
    if (/^CREATE TABLE/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/^SELECT state/i.test(sql)) return { rows: records.has(values[0]) ?
      [{ state: structuredClone(records.get(values[0])) }] : [], rowCount: records.has(values[0]) ? 1 : 0 };
    if (/^INSERT INTO/i.test(sql)) {
      const [id, json] = values;
      const existed = records.has(id);
      if (!existed || /DO UPDATE/.test(sql)) records.set(id, JSON.parse(json));
      return {rows:[],rowCount:existed && /DO NOTHING/.test(sql) ? 0 : 1};
    }
    if (/^UPDATE/i.test(sql)) { records.set(values[0], JSON.parse(values[1])); return {rows:[],rowCount:1}; }
    if (/^DELETE/i.test(sql)) { records.delete(values[0]); return {rows:[],rowCount:1}; }
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) return {rows:[],rowCount:0};
    throw new Error(`unexpected SQL ${sql}`);
  };
  const pool = { query, connect:async()=>({query,release:()=>{}}),end:async()=>{} };
  return new PostgresAtomicRecords({pool});
}
const state = { userId:'u1', projectId:'p1', artifactSha256:'a'.repeat(64),
  input:{hello:'world'}, workflowName:'ProjectManager', allowedOperations:['http.post'],
  protocolVersion:2, executionMode:'memory' };
for (const [kind, builder] of [['Firestore adapter', fireDb], ['Realtime ETag adapter', realtimeDb], ['PostgreSQL adapter SQL lifecycle', fakePgPool]]) {
  test(`${kind}: memory execution ownership and terminal invariants`, async () => {
    const records = builder();
    const store = new NativeMemoryExecutionPilotStore({records});
    const key = 'native_test_1';
    const created = await store.create({ executionId:key, ...state });
    assert.equal(created.status,'ready');
    await assert.rejects(store.create({ executionId:key, ...state }), /already exists/);
    assert.deepEqual((await store.get(key)).input,state.input);
    const claim = await store.claim({executionId:key,workerId:'w1',expectedUserId:'u1',expectedProjectId:'p1',leaseMs:10000});
    assert.equal(claim.epoch,1);
    await assert.rejects(store.claim({executionId:key,workerId:'w2',leaseMs:10000}), /lease held/);
    await store.updateMemoryProgress({executionId:key,workerId:'w1',epoch:1,progress:{effectCount:5}});
    assert.equal((await store.get(key)).effectCount,5);
    await assert.rejects(store.complete({executionId:key,workerId:'w2',epoch:1,result:'bad'}), /stale/);
    await store.complete({executionId:key,workerId:'w1',epoch:1,result:{success:true},effectCount:5});
    assert.equal((await store.get(key)).status,'completed');
    await assert.rejects(store.complete({executionId:key,workerId:'w1',epoch:1,result:'bad'}), /stale/);
    await assert.rejects(store.cancel({executionId:key,userId:'u1',projectId:'p1'}), /cancel/);
    const replay = await store.claim({executionId:key,workerId:'w2',leaseMs:10000});
    assert.deepEqual(replay,{ completed:true,result:{success:true} });
    await records.delete(key);
  });
  test(`${kind}: cancellation fences original owner`, async () => {
    const records=builder(), store=new NativeMemoryExecutionPilotStore({records});
    const key='native_test_2';
    await store.create({ executionId:key, ...state });
    const lease=await store.claim({executionId:key,workerId:'worker',leaseMs:10000});
    await store.cancel({executionId:key,userId:'u1',projectId:'p1'});
    assert.equal((await store.get(key)).status,'cancelled');
    await assert.rejects(store.complete({executionId:key,workerId:'worker',epoch:lease.epoch,result:true}),/stale/);
    await records.delete(key);
  });
}

test('Realtime ETag adapter retries CAS after an unrelated racing update', async()=>{
  const records = realtimeDb();
  await records.create('racing',{value:0});
  const first=await records.mutate('racing',old=>({...old,value:old.value+1}));
  const second=await records.mutate('racing',old=>({...old,value:old.value+1}));
  assert.equal(first.value,1);
  assert.equal(second.value,2);
});
