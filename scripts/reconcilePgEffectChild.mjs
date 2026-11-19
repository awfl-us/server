/** Test-only worker: pause after the HTTP result, before completing the native execution. */
import pg from 'pg';
import {PostgresAtomicRecords} from '../storage/pilot/adapters/postgres.js';
import {NativeMemoryExecutionPilotStore} from '../storage/pilot/memoryExecutionState.js';
import {localReleases,createLocalJobsHttpHandlers} from './nativeLocalDev.mjs';
import {runNativeMemoryWorkflow} from '../workflows/native/memoryWorker.js';
if(process.env.AWFL_RECONCILE_EFFECT_WORKER !== '1') throw new Error('test-only effect worker');
const pool=new pg.Pool({connectionString:process.env.PGTEST_URL,max:2});
const records=new PostgresAtomicRecords({pool,table:'reconcile_native_integration'});
const store=new NativeMemoryExecutionPilotStore({records});
const releases=await localReleases(process.env.AWFL_NATIVE_LOCAL_BUILD_REPORT);
const identity={userId:'reconcile-user',projectId:'reconcile-project'};
const live=createLocalJobsHttpHandlers({identity,
  jobsOrigin:'https://jobs-4wmfqir74q-uc.a.run.app',localJobsUrl:process.env.RECONCILE_JOBS_URL,
  seen:[],missing:[],failedRequests:[]});
const handlers={
  'http.get':async(effect)=>{
    const reply=await live['http.get'](effect);
    process.stdout.write('AWFL_RECONCILE_EFFECT_RESPONDED\n');
    // Freeze after external HTTP returned but before the native process can
    // advance to its terminal SQL write. The test parent issues SIGKILL.
    await new Promise(()=>{});
    return reply;
  },
};
await runNativeMemoryWorkflow({store,releases,handlers,
  executionId:process.env.RECONCILE_EXECUTION_ID,...identity});
