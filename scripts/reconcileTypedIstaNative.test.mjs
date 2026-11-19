/**
 * Exercises real compiled Scala Ista.tool(kala) schema through the Rust ABI.
 * Requires a dedicated native fixture artifact and isolated local Postgres.
 * Never calls OpenAI, GCP or the production Jobs service.
 */
import { test } from 'node:test';
import express from 'express';
import { createLlmRouter } from '../jobs/llm.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresAtomicRecords } from '../storage/pilot/adapters/postgres.js';
import { NativeMemoryExecutionPilotStore } from '../storage/pilot/memoryExecutionState.js';
import { runNativeMemoryWorkflow } from '../workflows/native/memoryWorker.js';
import { localReleases } from './nativeLocalDev.mjs';
import { parseTypedToolCalls } from '../jobs/llm/typedToolArguments.js';
import { buildChatPayload } from '../jobs/providers/openai.js';
import { runReconciliationScenario } from './reconcileScenario.mjs';

const REPORT = process.env.AWFL_TYPED_ISTA_REPORT;
const DB = process.env.PGTEST_URL;
const active = Boolean(REPORT && DB);
if (active) {
  const dbUrl = new URL(DB);
  if (!['localhost','127.0.0.1','[::1]'].includes(dbUrl.hostname) ||
      dbUrl.pathname !== '/awfl_reconcile' ||
      !['postgres:','postgresql:'].includes(dbUrl.protocol)) {
    throw new Error('Typed Ista fixture refuses non-loopback /awfl_reconcile database');
  }
}

test('Ista.tool(kala) retains strict schema from Scala through native Rust and OpenAI payload',
  {skip: !active,timeout:150_000}, async () => {
    const pool = new pg.Pool({connectionString: DB,max:3});
    const records = new PostgresAtomicRecords({pool,table:'reconcile_typed_ista'});
    const store = new NativeMemoryExecutionPilotStore({records});
    const releases = await localReleases(REPORT);
    const root = await releases.active('helpers-TypedIstaSchemaFixture');
    assert.ok(root, 'Compile helpers-TypedIstaSchemaFixture with native-dev.py first');
    const executionId = 'native_' + randomUUID().replaceAll('-', '');
    await records.initialize();
    try {
      await store.create({
        executionId,userId:'reconcile-user',projectId:'reconcile-project',
        workflowName:'helpers-TypedIstaSchemaFixture',artifactSha256:root.sha256,
        allowedOperations:[...root.allowedOperations],protocolVersion:2,
        streamIpcVersion:root.streamIpcVersion,
        trustedGlobalsVersion:root.trustedGlobalsVersion,input:{}
      });
      const run = () => runNativeMemoryWorkflow({store,releases,handlers:{},
        executionId,userId:'reconcile-user',projectId:'reconcile-project'});
      const first = await run();
      assert.equal((await store.get(executionId)).status,'completed');
      assert.deepEqual(await run(),first,'completed native replay must be deterministic');
      const tool = first.tool;
      assert.deepEqual(Object.keys(tool).sort(),['function','type']);
      assert.equal(tool.type,'function');
      assert.equal(tool.function.name,'READ_TYPED');
      assert.equal(tool.function.description,'Read files in the current segment');
      const schema = tool.function.parameters;
      assert.equal(schema.type,'object');
      assert.equal(schema.additionalProperties,false);
      assert.deepEqual(new Set(schema.required),new Set(['path','maxLines','history','counts']));
      assert.deepEqual(schema.properties.note.oneOf,[{type:'string'},{type:'null'}]);
      assert.deepEqual(schema.properties.tags.oneOf,[
        {type:'array',items:{type:'string'}},{type:'null'}]);
      assert.deepEqual(schema.properties.history,{type:'array',items:{type:'boolean'}});
      assert.deepEqual(schema.properties.counts,{type:'object',additionalProperties:{type:'integer'}});
      assert.ok(!JSON.stringify(tool).includes('workflowName'),
        'routing metadata must never reach model');
      assert.equal(first.routed.workflowName,'tools-ReadTyped');
      assert.equal(first.routed.type,'function');
      assert.deepEqual(first.routed.function,tool.function,
        'routed Ista must retain exactly the model-facing schema');
      const readFileTool=first.routedReadFile;
      assert.equal(readFileTool.workflowName,'tools-CliTools');
      assert.equal(readFileTool.function.name,'READ_FILE');
      assert.equal(readFileTool.function.parameters.additionalProperties,false);
      assert.deepEqual(readFileTool.function.parameters.required,['filepath']);
      assert.ok(!('workflowName' in readFileTool.function));
      const payload=buildChatPayload({model:'gpt-6.1-terra',
        messages:[{role:'user',content:'Read a file'}],tools:[tool],tool_choice:'auto'});
      assert.deepEqual(payload.tools,[tool]);
      const args={path:'sample.scala',maxLines:5,history:[true],counts:{reads:1},note:null};
      const response={tool_calls:[{id:'call-1',type:'function',function:{
        name:'READ_TYPED',arguments:JSON.stringify(args)}}]};
      assert.deepEqual(parseTypedToolCalls(response,[tool])[0].arguments,args);
      assert.throws(()=>parseTypedToolCalls({tool_calls:[{id:'call-2',type:'function',
        function:{name:'READ_TYPED',arguments:JSON.stringify({...args,counts:{reads:'bad'}})}}]},
        [tool]),/counts.reads: expected integer/);

      // Cross the actual Jobs Express route with the tool schema created by
      // the compiled Scala -> Rust fixture, not a hand-written JS schema.
      let nextArguments = args;
      const accounted = [];
      const observed = [];
      const app = express();
      app.use(express.json());
      app.use((req,_res,next) => {
        req.userId='reconcile-user';
        req.projectId='reconcile-project';
        next();
      });
      app.use('/llm',createLlmRouter({
        apiKeyForUser: async ()=>'test-only-key',
        adapters: {openai:{chat: async params => {
          observed.push(params);
          return {message:{role:'assistant',tool_calls:[{id:'call-rust',type:'function',
            function:{name:'READ_TYPED',arguments:JSON.stringify(nextArguments)}}]},
            usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}};
        }}},
        recordUsage: async entry => {accounted.push(entry);}
      }));
      const server=app.listen(0,'127.0.0.1');
      try {
        await new Promise(resolve=>server.once('listening',resolve));
        const post=async()=>{
          const response=await fetch(
            `http://127.0.0.1:${server.address().port}/llm/chat`,{
              method:'POST',headers:{'content-type':'application/json'},
              body:JSON.stringify({model:'gpt-6.1-terra',messages:[{role:'user',content:'Read'}],
                tools:[tool],validate_tool_arguments:true,sessionId:'typed-fixture'})
            });
          return {status:response.status,body:await response.json()};
        };
        assert.equal((await post()).status,200);
        assert.deepEqual(observed[0].tools,[tool],
          'real Jobs router must forward native generated JSON Schema unchanged');
        nextArguments={...args,counts:{reads:'bad'}};
        const rejected=await post();
        assert.equal(rejected.status,422);
        assert.match(rejected.body.reason,/counts.reads: expected integer/);
        assert.equal(accounted.length,2,'both provider calls consume tokens');
        assert.ok(!JSON.stringify(rejected.body).includes('sample.scala'));
      } finally {
        await new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
      }
      // The optional full-closure gate uses the actual compiled ProjectManager,
      // ToolDispatcher and CliTools Rust artifacts. The fixture's generated
      // READ_FILE tool definition flows through the ordinary service lookup.
      if (process.env.AWFL_NATIVE_LOCAL_BUILD_REPORT) {
        const scenario=await runReconciliationScenario({
          reportPath:process.env.AWFL_NATIVE_LOCAL_BUILD_REPORT,
          scenario:'typed-tool-roundtrip',typedToolDef:readFileTool,
          strictBackground:true,
        });
        assert.equal(scenario.native.status,'completed',JSON.stringify({
          error:scenario.native.error, result:scenario.native.result,
          lanes:scenario.native.lanes,missing:scenario.native.missing,
          effectCount:scenario.native.effectCount,
          modelCalls:scenario.modelRequests.length,
          httpRequests:scenario.requests.length,
          roles:scenario.messages.map(message=>message.value?.role||message.role)
        }));
        assert.equal(scenario.native.detachedDrainError,null);
        assert.deepEqual(scenario.native.missing,[]);
        assert.deepEqual(scenario.native.lanes.filter(lane=>lane.status==='failed'),[]);
        const messages=scenario.messages.map(message=>message.value||message);
        assert.deepEqual(messages.map(message=>message.role),
          ['user','assistant','tool','assistant']);
        const call=messages[1].tool_calls[0];
        assert.equal(call.id,'read-fixture-1');
        assert.deepEqual(parseTypedToolCalls({tool_calls:[call]},[
          {type:readFileTool.type,function:readFileTool.function}
        ])[0].arguments,{filepath:'/tmp/reconcile-config.json'});
        assert.equal(messages[2].tool_call_id,call.id);
        assert.deepEqual(JSON.parse(messages[2].content),{
          content:'{"debug":true}',filepath:'/tmp/reconcile-config.json'
        });
        const modelCalls=scenario.modelRequests.filter(
          request=>request.workflow_name==='codebase-ProjectManager');
        assert.equal(modelCalls.length,2);
        assert.equal(modelCalls[1].messages.filter(
          message=>message.role==='tool'&&message.tool_call_id===call.id).length,1);
        assert.equal(scenario.requests.filter(
          request=>request.path==='/events'&&
            request.body?.data?.tool_call?.id===call.id).length,1,
          'native CLI dispatch must enqueue exactly one callback event');
      }
    } finally {
      await records.delete(executionId).catch(()=>{});
      await records.close();
    }
  });
