import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NativeWorkflowBackend} from '../../workflows/native/backend.js';
import {nativeExecutionStatus,cancelNativeExecution} from '../../workflows/native/executionApi.js';
import {nativeDocumentStoreEnabled} from '../../storage/nativeMemory.js';

const sha='b'.repeat(64);
const uuid='1'.repeat(32);
function makeBackend({protocolVersion=2,allowedOperations=[]}={}) {
  const legacy=new Map(),memory=new Map(),tasks=[];
  const store=map=>({
    create:async state=>map.set(state.executionId,{...state,status:'ready',updatedAt:100}),
    get:async id=>map.get(id),
    cancel:async ({executionId})=>{map.get(executionId).status='cancelled';},
  });
  const legacyStore=store(legacy),memoryStore=store(memory);
  const backend=new NativeWorkflowBackend({
    store:legacyStore,memoryStore,
    releases:{active:async()=>({sha256:sha,protocolVersion,allowedOperations})},
    tasksClient:{queuePath:()=> 'q',createTask:async spec=>tasks.push(spec)},
    gcpProject:'awfl-us',region:'us-central1',queue:'q',
    jobsUrl:'https://jobs.example.org',
    taskServiceAccount:'task-worker@awfl-us.iam.gserviceaccount.com',
    uuid:()=>uuid,
  });
  return {backend,legacy,memory,tasks,memoryStore};
}

test('explicit document store keeps creation, status and cancellation on one provider',async()=>{
  const before=process.env.AWFL_NATIVE_MEMORY_EXECUTION_ENABLED;
  process.env.AWFL_NATIVE_MEMORY_EXECUTION_ENABLED='1';
  try {
    const {backend,legacy,memory,tasks,memoryStore}=makeBackend();
    const launch=await backend.maybeStart({workflowName:'NativePilot',userId:'u',projectId:'p',argument:{n:1}});
    assert.equal(legacy.size,0);
    assert.equal(memory.size,1);
    assert.equal(memory.get('native_'+uuid).executionMode,'memory');
    assert.equal(tasks.length,1);
    assert.equal(JSON.parse(Buffer.from(tasks[0].task.httpRequest.body,'base64')).executionMode,'memory');
    const status=await nativeExecutionStatus({db:null,execId:'native_'+uuid,userId:'u',projectId:'p',memoryStore});
    assert.equal(status.data.status,'Running');
    await assert.rejects(()=>nativeExecutionStatus({db:null,execId:'native_'+uuid,userId:'intruder',projectId:'p',memoryStore}),x=>x.code==='NOT_FOUND');
    await cancelNativeExecution({db:null,execId:'native_'+uuid,userId:'u',projectId:'p',memoryStore});
    assert.equal(memory.get('native_'+uuid).status,'cancelled');
    assert.equal(legacy.size,0);
    const state=await launch.client.getExecution({name:launch.executionName});
    assert.equal(state[0].state,'CANCELLED');
  }finally{
    if(before===undefined) delete process.env.AWFL_NATIVE_MEMORY_EXECUTION_ENABLED;
    else process.env.AWFL_NATIVE_MEMORY_EXECUTION_ENABLED=before;
  }
});

test('unsupported durable execution fails before writing to either provider',async()=>{
  const before=process.env.AWFL_NATIVE_MEMORY_EXECUTION_ENABLED;
  delete process.env.AWFL_NATIVE_MEMORY_EXECUTION_ENABLED;
  try{
    const {backend,legacy,memory,tasks}=makeBackend();
    await assert.rejects(()=>backend.maybeStart({workflowName:'NativePilot',userId:'u',projectId:'p',argument:{}}),/memory executions only/);
    assert.equal(legacy.size,0);assert.equal(memory.size,0);assert.equal(tasks.length,0);
  }finally{
    if(before===undefined) delete process.env.AWFL_NATIVE_MEMORY_EXECUTION_ENABLED;
    else process.env.AWFL_NATIVE_MEMORY_EXECUTION_ENABLED=before;
  }
});

test('document-mode switch is explicit and disabled by default',()=>{
  assert.equal(nativeDocumentStoreEnabled({}),false);
  assert.equal(nativeDocumentStoreEnabled({AWFL_NATIVE_DOCUMENT_STORE_ENABLED:'1'}),true);
});
