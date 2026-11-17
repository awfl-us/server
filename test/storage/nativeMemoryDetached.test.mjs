import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocumentAtomicRecords } from '../../storage/document/atomicRecords.js';
import { NativeMemoryExecutionPilotStore } from '../../storage/pilot/memoryExecutionState.js';
import { createNativeAsyncScheduler } from '../../workflows/native/asyncScheduler.js';

function fakeDocuments() {
  const map = new Map();
  const clone = value => structuredClone(value);
  const wrap = path => map.has(path) ? { path, id: path.split('/').at(-1), data: clone(map.get(path)) } : null;
  const store = {
    async get(path) { return wrap(path); },
    async create(path, value) {
      if (map.has(path)) throw Object.assign(new Error('document already exists'), { code: 'ALREADY_EXISTS' });
      map.set(path, clone(value));
    },
    async put(path, value) { map.set(path, clone(value)); },
    async update() { throw new Error('unused'); },
    async delete(path) { map.delete(path); },
    async query({ collection, where = [], limit = 100 }) {
      return [...map.keys()].filter(path => path.startsWith(collection + '/'))
        .filter(path => path.slice(collection.length + 1).indexOf('/') === -1)
        .map(wrap).filter(doc => where.every(({ field, op, value }) =>
          op === '==' && doc.data[field] === value)).slice(0, limit);
    },
    async count(query) { return (await this.query(query)).length; },
    async listCollections() { return []; },
    async batch() { throw new Error('unused'); },
    async transaction(fn) {
      // Deterministic fake only for the protocol tests; serializable
      // concurrency is separately covered by the real PG integration tests.
      return fn({ get: this.get.bind(this), create: this.create.bind(this),
        put: this.put.bind(this), delete: this.delete.bind(this) });
    },
    async subscribe() { throw new Error('unused'); },
    async close() {},
  };
  return { store, map };
}

const a = 'native_' + 'a'.repeat(32);
const b = 'native_' + 'b'.repeat(32);
const identity = { userId:'user', projectId:'project' };
const release = { workflowName:'NativeChild', artifactSha256:'c'.repeat(64),
  protocolVersion:2,allowedOperations:['http.post'], input:{ task:42 } };

test('provider-neutral memory store persists and scans detached roots', async () => {
  const { store } = fakeDocuments();
  const records = new DocumentAtomicRecords({storage:store});
  const clock = {now:1000};
  const native = new NativeMemoryExecutionPilotStore({records,clock:()=>clock.now});
  await native.create({executionId:a,...identity,...release,asyncLaunch:true});
  await native.create({executionId:b,...identity,...release});
  assert.deepEqual((await native.listPendingAsync()).map(x=>x.executionId), [a]);
  assert.equal((await native.get(a)).asyncLaunch,true);
  const claimed = await native.claim({executionId:a,workerId:'first',leaseMs:5000,...{
    expectedUserId:identity.userId,expectedProjectId:identity.projectId}});
  assert.equal(claimed.epoch,1);
  clock.now+=5001;
  const resumed = await native.claim({executionId:a,workerId:'second',leaseMs:5000,
    expectedUserId:identity.userId,expectedProjectId:identity.projectId});
  assert.equal(resumed.epoch,2);
  assert.deepEqual(resumed.input,release.input);
  await native.complete({executionId:a,workerId:'second',epoch:2,result:{ok:true},effectCount:1});
  assert.deepEqual(await native.listPendingAsync(),[]);
  assert.deepEqual((await native.get(a)).result,{ok:true});
});

test('detached recovery scanner enqueues pending roots without touching normal roots', async () => {
  const { store } = fakeDocuments();
  const records = new DocumentAtomicRecords({storage:store});
  const native = new NativeMemoryExecutionPilotStore({records,clock:Date.now});
  await native.create({executionId:a,...identity,...release,asyncLaunch:true});
  await native.create({executionId:b,...identity,...release});
  const executed = [];
  const scheduler = createNativeAsyncScheduler({
    store:native,execute:async ({executionId}) => executed.push(executionId),
  });
  await scheduler.scan();
  await scheduler.drain();
  assert.deepEqual(executed,[a]);
  await scheduler.close();
});
