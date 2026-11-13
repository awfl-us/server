import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeStorageEffectHandler } from './storageEffects.js';

const identity = { userId: 'owner', projectId: 'project' };

function storageFixture(size = 10) {
  const calls = [];
  const storage = {
    bucket(bucket) {
      calls.push({ bucket });
      return {
        file(object) {
          calls.push({ object });
          return {
            getMetadata: async () => [{ size }],
            download: async () => [Buffer.from('hello rust')],
          };
        },
      };
    },
  };
  return { calls, storage };
}

test('native Storage object_get reads workflow file from bounded allowlisted bucket', async () => {
  const { storage, calls } = storageFixture();
  const result = await createNativeStorageEffectHandler({ storage })({
    args: { bucket: 'awfl-us-workflow-files${workflow_env}',
      object: 'scripts%2Fagent.sh', alt: 'media' }, identity,
  });
  assert.equal(result, 'hello rust');
  assert.deepEqual(calls, [
    { bucket: 'awfl-us-workflow-files' }, { object: 'scripts/agent.sh' },
    { bucket: 'awfl-us-workflow-files' }, { object: 'scripts/agent.sh' },
  ]);
});

test('native Storage handler rejects arbitrary buckets, traversal, oversize and ownerless calls', async () => {
  const args = { bucket: 'awfl-us-workflow-files', object: 'scripts%2Fagent.sh', alt: 'media' };
  for (const bad of [
    { ...args, bucket: 'other-private-bucket' },
    { ...args, object: '..%2Fcredentials.json' },
    { ...args, object: '/etc/passwd' },
    { ...args, object: 'scripts%2F%2E%2E%2Fprivate' },
  ]) {
    const f = storageFixture();
    await assert.rejects(createNativeStorageEffectHandler({ storage: f.storage })({
      args: bad, identity,
    }));
    assert.equal(f.calls.length, 0);
  }
  const f = storageFixture(1024 * 1024);
  await assert.rejects(createNativeStorageEffectHandler({ storage: f.storage })({
    args, identity,
  }), /size limit/);
  await assert.rejects(createNativeStorageEffectHandler({ storage: f.storage })({
    args, identity: { userId: '', projectId: 'project' },
  }), /trusted native storage effect/);
});
