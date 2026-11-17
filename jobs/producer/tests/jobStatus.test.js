import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyK8sJob } from '../jobStatus.js';
import { consumerResourcesForProfile } from '../resourceProfiles.js';

test('evicted pod plus running replacement is still an active Job', () => {
  assert.equal(classifyK8sJob({
    status: { failed: 1, active: 1 },
    spec: { backoffLimit: 3 },
  }), 'active');
  assert.equal(classifyK8sJob({
    status: { failed: 3, active: 1 },
    spec: { backoffLimit: 3 },
  }), 'active');
});

test('retry backoff with failed previous pods remains pending, not terminal', () => {
  assert.equal(classifyK8sJob({
    status: { failed: 1, active: 0 },
    spec: { backoffLimit: 3 },
  }), 'pending');
  assert.equal(classifyK8sJob({
    status: { failed: 3, active: 0 },
    spec: { backoffLimit: 3 },
  }), 'pending');
});

test('terminal Failed and FailureTarget conditions deny re-bootstrap even with an active count', () => {
  for (const type of ['Failed', 'FailureTarget']) {
    assert.equal(classifyK8sJob({
      status: { failed: 1, active: 1, conditions: [{ type, status: 'True' }] },
      spec: { backoffLimit: 3 },
    }), 'failed');
  }
});

test('an exhausted retry budget without an active pod is failed', () => {
  assert.equal(classifyK8sJob({
    status: { failed: 4, active: 0 },
    spec: { backoffLimit: 3 },
  }), 'failed');
});

test('completed, deleting and pending Jobs are classified correctly', () => {
  assert.equal(classifyK8sJob({
    metadata: { deletionTimestamp: '2026-11-17T18:40:00Z' },
    status: { active: 1, failed: 1 },
  }), 'terminating');
  assert.equal(classifyK8sJob({ status: {
    succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }],
  }}), 'completed');
  assert.equal(classifyK8sJob({ status: { succeeded: 1 } }), 'completed');
  assert.equal(classifyK8sJob({ status: {} }), 'pending');
  assert.equal(classifyK8sJob({ status: { active: 1, failed: 1,
    conditions: [{ type: 'Failed', status: 'False' }] } }), 'active');
});

test('each consumer profile has equal ephemeral storage request/limit and enough room for tooling', () => {
  for (const profile of ['lightweight', 'browser', 'scala']) {
    const resources = consumerResourcesForProfile(profile);
    assert.equal(resources.requests['ephemeral-storage'], '4Gi');
    assert.equal(resources.limits['ephemeral-storage'], '4Gi');
  }
});
