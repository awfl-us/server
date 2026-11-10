import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLiveWorkspace, readyJobPod, verifyWorkflowIdentity, validWorkspaceId, validPort } from './resolve.js';

const now = 200000;
const ws = { userId: 'owner', projectId: 'project', expiresAt: now + 10000 };
const lock = { consumerId: 'consumer-1', acquiredAt: 150000, expiresAt: now + 10000,
  runtime: { mode: 'gke', namespace: 'awfl', consumerJobName: 'consumer-abc' },
  heartbeat: { consumerId: 'consumer-1', generation: 150000, at: now - 1000, connected: true } };

test('only live GKE project consumer lock may be forwarded', () => {
  assert.deepEqual(resolveLiveWorkspace(ws, lock, now), { consumerId: 'consumer-1', generation: 150000, jobName: 'consumer-abc', namespace: 'awfl' });
  for (const bad of [{...lock, expiresAt: now - 1}, {...lock, runtime: {...lock.runtime, mode:'docker'}},
    {...lock, heartbeat:{...lock.heartbeat, generation:5}}, {...lock, heartbeat:{...lock.heartbeat, at: now - 31000}}]) {
    assert.throws(() => resolveLiveWorkspace(ws, bad, now));
  }
  assert.throws(() => resolveLiveWorkspace({...ws, stopped:true}, lock, now));
});

test('only exactly one running, Ready, Job-owned pod is eligible', () => {
  const pod={metadata:{name:'consumer-abc-123',ownerReferences:[{kind:'Job',name:'consumer-abc',controller:true}]},
    status:{phase:'Running',conditions:[{type:'Ready',status:'True'}]}};
  assert.equal(readyJobPod([pod], 'consumer-abc'),'consumer-abc-123');
  assert.throws(()=>readyJobPod([{...pod,metadata:{...pod.metadata,ownerReferences:[{kind:'Job',name:'other',controller:true}]}}],'consumer-abc'));
  assert.throws(()=>readyJobPod([pod,pod],'consumer-abc'));
});

test('workflow audience and service account both have to match', () => {
  const expected={audience:'https://api.awfl.us/dev/abc/5050',allowedEmails:['123-compute@developer.gserviceaccount.com']};
  assert.equal(verifyWorkflowIdentity({aud:expected.audience,email:expected.allowedEmails[0],email_verified:true},expected), expected.allowedEmails[0]);
  assert.throws(()=>verifyWorkflowIdentity({aud:'wrong',email:expected.allowedEmails[0],email_verified:true},expected));
  assert.throws(()=>verifyWorkflowIdentity({aud:expected.audience,email:'other@example.com',email_verified:true},expected));
});

test('workspace and port identifiers are constrained', () => {
  assert.ok(validWorkspaceId('a'.repeat(32)) && validPort('5050'));
  assert.ok(!validWorkspaceId('../secrets') && !validPort('65536') && !validPort('-1') && !validPort('5050:evil'));
});
