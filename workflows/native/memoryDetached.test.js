import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDetachedLauncher } from './memoryDetached.js';

const executionId = 'native_' + 'd'.repeat(32);

test('memory detached child persists and schedules under the validated caller project', async () => {
  const records = [], scheduled = [];
  const launch = createMemoryDetachedLauncher({
    executionId, userId: 'owner', projectId: 'parent',
    store: {
      create: async document => records.push(document),
      get: async () => null,
    },
    releases: {
      active: async name => ({
        workflowName: name, sha256: 'a'.repeat(64),
        protocolVersion: 2, allowedOperations: [],
      }),
    },
    asyncScheduler: { enqueue: request => scheduled.push(request) },
  });
  const res = await launch({
    name: 'BackgroundAgent', args: { argument: { task: 'synthetic' } },
    path: 'root:child', effectId: 'effect_1',
    identity: { userId: 'owner', projectId: 'tmp-project' },
  });
  assert.equal(res.state, 'ACTIVE');
  assert.equal(records.length, 1);
  assert.equal(records[0].projectId, 'tmp-project');
  assert.equal(records[0].userId, 'owner');
  assert.deepEqual(scheduled, [{
    executionId: records[0].executionId, userId: 'owner', projectId: 'tmp-project',
  }]);
});

test('memory detached launcher rejects a changed user before writing', async () => {
  let created = 0;
  const launch = createMemoryDetachedLauncher({
    executionId, userId: 'owner', projectId: 'parent',
    store: { create: async () => { created++; }, get: async () => null },
    releases: { active: async () => ({
      sha256: 'b'.repeat(64), protocolVersion: 2, allowedOperations: [],
    }) },
    asyncScheduler: { enqueue: () => {} },
  });
  await assert.rejects(launch({
    name: 'BackgroundAgent', args: { argument: {} },
    path: 'root:child', effectId: 'effect_1',
    identity: { userId: 'other', projectId: 'tmp-project' },
  }), /identity mismatch/);
  assert.equal(created, 0);
});
