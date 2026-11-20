/** Direct compiled native ToolDispatcher regression: unknown functions and
 * model-only function definitions must not run workflows or save tool results.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PostgresAtomicRecords} from '../storage/pilot/adapters/postgres.js';
import {NativeMemoryExecutionPilotStore} from '../storage/pilot/memoryExecutionState.js';
import {runNativeMemoryWorkflow} from '../workflows/native/memoryWorker.js';
import {localReleases} from './nativeLocalDev.mjs';

const database=process.env.PGTEST_URL;
const report=process.env.AWFL_NATIVE_LOCAL_BUILD_REPORT;
const enabled=Boolean(database && report);
if (enabled) {
  const parsed=new URL(database);
  if (!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname) ||
      parsed.pathname!=='/awfl_reconcile')
    throw new Error('Refusing to run native dispatcher test outside isolated PostgreSQL');
}

test('compiled dispatcher ignores unregistered or non-executable function calls',
  {skip:!enabled,timeout:60000},async()=>{
    process.env.NODE_ENV='test';
    process.env.GCP_PROJECT ||= 'awfl-us';
    const pool=new pg.Pool({connectionString:database,max:4});
    const records=new PostgresAtomicRecords({pool,table:'reconcile_registered_dispatch'});
    await records.initialize();
    const store=new NativeMemoryExecutionPilotStore({records});
    const releases=await localReleases(report);
    const root=await releases.active('helpers-ToolDispatcher');
    assert.ok(root,'compiled ToolDispatcher release must be available');
    const identity={userId:'registered-dispatch-'+randomUUID().replaceAll('-',''),
      projectId:'reconcile-project'};
    const definitions=[{
      type:'function',
      function:{name:'READ_FILE',description:'Read a file',
        parameters:{type:'object',properties:{},required:[]}},
      workflowName:'tools-CliTools'
    },{
      type:'function',
      function:{name:'MODEL_ONLY',description:'Return a typed result',
        parameters:{type:'object',properties:{},required:[]}},
      workflowName:''
    }];
    const inputs=[
      {name:'UNKNOWN',expected:'unknown registration'},
      {name:'MODEL_ONLY',expected:'non-executable registration'},
    ];
    const ids=[];
    try {
      for (const {name,expected} of inputs) {
        const executionId='native_'+randomUUID().replaceAll('-','');
        ids.push(executionId);
        const input={totalCost:0,toolDefs:definitions,toolCalls:[{
          id:'output-'+name,type:'function',function:{name,arguments:'{}'}
        }],env:{...identity,sessionId:'reconcile-test-session',
          BASE_URL:'https://jobs-4wmfqir74q-uc.a.run.app'}};
        await store.create({executionId,...identity,workflowName:root.workflowName,
          artifactSha256:root.sha256,protocolVersion:2,
          allowedOperations:[...root.allowedOperations],
          parallelVersion:root.parallelVersion,
          streamIpcVersion:root.streamIpcVersion,
          trustedGlobalsVersion:root.trustedGlobalsVersion,input});
        const postRequests=[];
        const result=await runNativeMemoryWorkflow({store,releases,
          handlers:{'log.write':async()=>null,'http.post':async ({args})=>{
            postRequests.push(args.url);
            assert.equal(new URL(args.url).pathname,'/firebase/create',
              'an unmatched tool call must not persist a conversation tool result');
            return {code:200,body:{}};
          }},executionId,...identity});
        assert.deepEqual(result,{results:[]},expected);
        assert.equal(postRequests.length,1,'only the normal workflow status write is allowed');
        assert.equal((await store.get(executionId)).status,'completed');
        const replay=await runNativeMemoryWorkflow({store,releases,
          handlers:{},executionId,...identity});
        assert.deepEqual(replay,result,expected+' replay');
      }
      console.log('REGISTERED_DISPATCH_PASS',inputs.map(x=>x.expected));
    } finally {
      for (const id of ids) await records.delete(id);
      await records.close();
    }
  });
