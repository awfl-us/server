import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consumerResourcesForProfile } from '../resourceProfiles.js';

test('Autopilot admission must not reduce ephemeral-storage limits', () => {
  for (const profile of ['lightweight', 'browser', 'scala', null]) {
    const { requests, limits } = consumerResourcesForProfile(profile);
    assert.equal(requests['ephemeral-storage'], limits['ephemeral-storage'], profile);
  }
});

test('lightweight keeps low-cost storage while browser and Scala get working space', () => {
  assert.equal(consumerResourcesForProfile('lightweight').requests['ephemeral-storage'], '1Gi');
  assert.equal(consumerResourcesForProfile('browser').requests['ephemeral-storage'], '2Gi');
  assert.equal(consumerResourcesForProfile('scala').requests['ephemeral-storage'], '4Gi');
  assert.equal(consumerResourcesForProfile(null).requests['ephemeral-storage'], '2Gi');
});

test('existing per-profile CPU and memory settings are unchanged', () => {
  assert.deepEqual(consumerResourcesForProfile('scala').requests, {
    cpu: '1', memory: '2Gi', 'ephemeral-storage': '4Gi',
  });
  assert.deepEqual(consumerResourcesForProfile('lightweight').requests, {
    cpu: '250m', memory: '1Gi', 'ephemeral-storage': '1Gi',
  });
  assert.deepEqual(consumerResourcesForProfile('browser').requests, {
    cpu: '500m', memory: '1536Mi', 'ephemeral-storage': '2Gi',
  });
});
