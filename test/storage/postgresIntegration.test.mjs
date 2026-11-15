import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresAtomicRecords } from '../../storage/pilot/adapters/postgres.js';
import { NativeMemoryExecutionPilotStore } from '../../storage/pilot/memoryExecutionState.js';

const enabled = Boolean(process.env.PGTEST_URL);
const spec = { userId: 'bench-ci', projectId: 'bench-project', artifactSha256: 'a'.repeat(64),
  input: { random: 'synthetic' }, workflowName: 'StorageTest',
  allowedOperations: ['http.post'], protocolVersion: 2, executionMode: 'memory' };

test('real PostgreSQL: exclusive claims, stale epochs, and completion', { skip: !enabled }, async () => {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.PGTEST_URL, max: 12 });
  const records = new PostgresAtomicRecords({pool});
  await records.initialize();
  const clock = {value:Date.now()};
  const store = new NativeMemoryExecutionPilotStore({records,clock:()=>clock.value});
  const key = 'ci_' + randomUUID().replaceAll('-', '');
  try {
    await store.create({executionId:key,...spec});
    await assert.rejects(store.create({executionId:key,...spec}), e => e.code === 'ALREADY_EXISTS');
    const candidates = Array.from({length:16},(_,i)=>'worker_'+i);
    const settled = await Promise.allSettled(candidates.map(workerId => store.claim({executionId:key,
      workerId,expectedUserId:spec.userId,expectedProjectId:spec.projectId,leaseMs:10000})));
    const winners = settled.flatMap((x,i)=> x.status==='fulfilled'?[{workerId:candidates[i],lease:x.value}]:[]);
    assert.equal(winners.length,1,'only one worker can claim an execution');
    assert.equal(settled.filter(x=>x.status==='rejected').length,15);
    const [{workerId,lease}]=winners;
    await assert.rejects(store.complete({executionId:key,workerId:'wrong',epoch:lease.epoch,result:1}),
      e=>e.code==='CONFLICT');
    await store.updateMemoryProgress({executionId:key,workerId,epoch:lease.epoch,
      progress:{effectCount:2}});
    clock.value += 10001;
    const reclaim = await store.claim({executionId:key,workerId:'new-owner',leaseMs:10000});
    assert.equal(reclaim.epoch,lease.epoch+1);
    await assert.rejects(store.complete({executionId:key,workerId,epoch:lease.epoch,result:'stale'}),
      e=>e.code==='CONFLICT');
    await store.complete({executionId:key,workerId:'new-owner',epoch:reclaim.epoch,
      result:{ok:true},effectCount:3});
    assert.equal((await store.get(key)).status,'completed');
    assert.deepEqual((await store.claim({executionId:key,workerId:'later'})).result,{ok:true});
    await assert.rejects(store.cancel({executionId:key,userId:spec.userId,projectId:spec.projectId}),
      e=>e.code==='CONFLICT');
  } finally {
    await records.delete(key);
    await records.close();
  }
});
