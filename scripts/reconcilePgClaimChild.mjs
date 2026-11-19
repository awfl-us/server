/** Test-only worker: claim a PostgreSQL-native execution, then wait to be killed. */
import pg from 'pg';
import { PostgresAtomicRecords } from '../storage/pilot/adapters/postgres.js';
import { NativeMemoryExecutionPilotStore } from '../storage/pilot/memoryExecutionState.js';
if (process.env.AWFL_RECONCILE_CLAIM_WORKER !== '1') throw new Error('test-only claim worker');
const pool = new pg.Pool({connectionString:process.env.PGTEST_URL,max:2});
const records = new PostgresAtomicRecords({pool,table:'reconcile_native_integration'});
const store = new NativeMemoryExecutionPilotStore({records});
const state = await store.claim({executionId:process.env.RECONCILE_EXECUTION_ID,
  userId: 'reconcile-user', workerId:'crashed-worker',
  expectedUserId:'reconcile-user',expectedProjectId:'reconcile-project',leaseMs:1000});
process.stdout.write(`AWFL_RECONCILE_CLAIMED ${JSON.stringify({epoch:state.epoch,workerId:'crashed-worker'})}\n`);
// SIGKILL is intentional in the parent test. No finally/complete is executed.
await new Promise(()=>{});
