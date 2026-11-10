import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createDevGateway } from './index.js';

const id = 'a'.repeat(32);
const now = Date.now();
const workspace = { userId:'workspace-owner', projectId:'workflows-project', expiresAt:now + 3600000 };
const lock = { consumerId:'consumer-1', acquiredAt:now-12000, expiresAt:now + 3600000,
  runtime:{mode:'gke',namespace:'awfl',consumerJobName:'consumer-test'},
  heartbeat:{consumerId:'consumer-1',generation:now-12000,at:now,connected:true} };
const pod = {metadata:{name:'consumer-test-abc',ownerReferences:[{kind:'Job',name:'consumer-test',controller:true}]},
  status:{phase:'Running',conditions:[{type:'Ready',status:'True'}]}};
const origin = 'https://api.awfl.example';

async function createHarness() {
  process.env.AWFL_DEV_GATEWAY_ORIGIN = origin;
  const verified = [];
  const forwarded = [];
  const db = {collection:name=>({doc:()=>({get:async()=>({exists:name==='mcpWorkspaces',data:()=>workspace})})})};
  const router = createDevGateway({db,isOwner:async()=>true,mode:'both',
    getLock:async()=>({lock}),getAllowedWorkflowEmails:async()=>['workflow@awfl.example'],
    verifyGoogleToken:async(token,audience)=>{
      verified.push({token,audience});
      if(token==='invalid') throw new Error('Invalid signature');
      return {aud:audience,email:'workflow@awfl.example',email_verified:true};
    },
    kubernetes:async()=>({makeApiClient:()=>({listNamespacedPod:async()=>({body:{items:[pod]}})})}),
    httpForward:async ({res,req,workflowHeaders,podName,path})=>{
      forwarded.push({auth:req.get('authorization'),workflowHeaders,podName,path});
      res.json({podName,path,workflowHeaders});
    },
  }).proxyRouter;
  const app=express();app.use('/dev',router);
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  return {url:`http://127.0.0.1:${server.address().port}/dev/${id}/5051/health`,verified,forwarded,
    close:()=>new Promise(resolve=>server.close(resolve))};
}

test('public api verifies OIDC against the complete BASE_URL, once, then forwards request headers',async()=>{
  const h=await createHarness();
  try {
    const response=await fetch(h.url,{headers:{authorization:'Bearer valid',
      'x-user-id':'application-user','x-project-id':'application-project'}});
    assert.equal(response.status,200);
    assert.deepEqual(h.verified,[{token:'valid',audience:`${origin}/dev/${id}/5051`}]);
    assert.deepEqual(await response.json(),{podName:'consumer-test-abc',path:'/health',
      workflowHeaders:{'x-user-id':'application-user','x-project-id':'application-project'}});
    assert.equal(h.forwarded[0].auth,'Bearer valid');
  } finally {await h.close();delete process.env.AWFL_DEV_GATEWAY_ORIGIN;}
});

test('public api requires a verified Workflow token before touching the pod',async()=>{
  const h=await createHarness();
  try {
    assert.equal((await fetch(h.url)).status,401);
    assert.equal((await fetch(h.url,{headers:{authorization:'Bearer invalid'}})).status,401);
    assert.equal(h.forwarded.length,0);
  } finally {await h.close();delete process.env.AWFL_DEV_GATEWAY_ORIGIN;}
});
