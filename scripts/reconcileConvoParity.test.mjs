/** Compare the original and extracted Convo compiled Rust graphs. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runReconciliationScenario} from './reconcileScenario.mjs';

const before=process.env.AWFL_CONVO_BASELINE_REPORT;
const after=process.env.AWFL_CONVO_EXTRACTED_REPORT;
const enabled=Boolean(before && after);
const foreground = requests => requests.filter(r=>
  ['codebase-ProjectManager','helpers-Convo'].includes(r.workflow_name));
const clean = value => {
  if(Array.isArray(value)) return value.map(clean);
  if(value && typeof value==='object') return Object.fromEntries(
    Object.entries(value)
      .filter(([k])=>!['workflow_name','create_time','timestamp','execution_id'].includes(k))
      .map(([k,v])=>[k,clean(v)]));
  return value;
};

test('native Convo extraction preserves model requests and persisted messages',
  {skip:!enabled,timeout:100000},async()=>{
    for(const scenario of ['basic','no-query','tool-roundtrip']) {
      const a=await runReconciliationScenario({reportPath:before,scenario,strictBackground:true});
      const b=await runReconciliationScenario({reportPath:after,scenario,strictBackground:true});
      assert.equal(a.native.status,'completed');
      assert.equal(b.native.status,'completed');
      assert.deepEqual(a.native.lanes.filter(x=>x.status==='failed'),[]);
      assert.deepEqual(b.native.lanes.filter(x=>x.status==='failed'),[]);
      const oldReq=foreground(a.modelRequests).map(clean);
      const newReq=foreground(b.modelRequests).map(clean);
      assert.deepEqual(newReq,oldReq,`model requests changed for ${scenario}`);
      const oldMessages=a.messages.map(x=>clean(x.value||x));
      const newMessages=b.messages.map(x=>clean(x.value||x));
      assert.deepEqual(newMessages,oldMessages,`persisted messages changed for ${scenario}`);
      console.log('CONVO_PARITY_PASS',scenario,oldReq.length,'model requests',oldMessages.length,'messages');
    }
  });
