import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { FirestoreAtomicRecords } from '../../storage/pilot/adapters/firestore.js';
import { RealtimeAtomicRecords } from '../../storage/pilot/adapters/realtime.js';
import { NativeMemoryExecutionPilotStore } from '../../storage/pilot/memoryExecutionState.js';

const enabled = Boolean(process.env.STORAGE_PILOT_EMULATORS);
const fingerprint = () => randomBytes(7).toString('hex');
const fixture = {
  userId:'test-user', projectId:'test-project', artifactSha256:'a'.repeat(64),
  workflowName:'StoragePilot', allowedOperations:['http.post'],
  protocolVersion:2, executionMode:'memory', input:{value:'x'.repeat(512)},
};
async function implementations() {
  const {initializeApp, getApps} = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  if (!getApps().length) initializeApp({projectId: 'demo-awfl'});
  return [
    ['Firestore emulator / Admin SDK', new FirestoreAtomicRecords({db:getFirestore(),collection:'nativeStorageBenchmark'})],
    ['RTDB emulator / REST ETags',new RealtimeAtomicRecords({
      databaseURL:`http://${process.env.RTDB_EMULATOR_HOST || '127.0.0.1:9009'}`,
      databaseNamespace:process.env.RTDB_EMULATOR_NAMESPACE || 'demo-awfl-default-rtdb',
      emulator:true,
    })],
  ];
}

test('real Firebase emulators: lifecycle + 16 racing claimants', { skip: !enabled, timeout:120_000 }, async t => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST,'FIRESTORE_EMULATOR_HOST must be set');
  for (const [label, records] of await implementations()) {
    await t.test(label, {timeout:60_000}, async () => {
      const store = new NativeMemoryExecutionPilotStore({records});
      const key='local_'+fingerprint();
      try {
        await store.create({executionId:key,...fixture});
        await assert.rejects(store.create({executionId:key,...fixture}),e=>e.code==='ALREADY_EXISTS');
        assert.deepEqual((await store.get(key)).input,fixture.input);
        const workers=Array.from({length:16},(_,i)=>`worker${i}`);
        const settled=await Promise.allSettled(workers.map(workerId=>store.claim({executionId:key,
          workerId,leaseMs:60_000,expectedUserId:fixture.userId,expectedProjectId:fixture.projectId})));
        const winners=settled.flatMap((x,i)=>x.status==='fulfilled' ? [{workerId:workers[i],state:x.value}] : []);
        assert.equal(winners.length,1,`expected one claimant: ${JSON.stringify(settled.map((x,i)=>x.status==='rejected' ? {worker:workers[i],error:x.reason?.message} : {worker:workers[i],won:true}))}`);
        const [{workerId,state}]=winners;
        await store.updateMemoryProgress({executionId:key,workerId,epoch:state.epoch,progress:{effectCount:2}});
        await assert.rejects(store.complete({executionId:key,workerId:'invalid',epoch:state.epoch,result:{ok:false}}),e=>e.code==='CONFLICT');
        await store.complete({executionId:key,workerId,epoch:state.epoch,result:{ok:true},effectCount:2});
        assert.equal((await store.get(key)).status,'completed');
        await assert.rejects(store.complete({executionId:key,workerId,epoch:state.epoch,result:{ok:false}}),e=>e.code==='CONFLICT');
      } finally {
        await records.delete(key);
        await records.close();
      }
    });
  }
});

test('RTDB emulator URL is explicitly loopback-only', () => {
  assert.throws(()=>new RealtimeAtomicRecords({databaseURL:'http://example.com',emulator:true,databaseNamespace:'demo-awfl-default-rtdb'}),/loopback emulator/);
  assert.throws(()=>new RealtimeAtomicRecords({databaseURL:'http://127.0.0.1:9009',emulator:false}),/HTTPS OAuth/);
});
