import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNativeExecutionId, nativeExecutionStatus,
  cancelNativeExecution } from './executionApi.js';

const execId = 'native_' + 'a'.repeat(32);
function fixture(status = 'ready') {
  let record = {
    executionId: execId, workflowName: 'NativePilot',
    userId: 'verified-user', projectId: 'project-a',
    status, updatedAt: 1234, epoch: 1,
    result: status === 'completed' ? { ok: true } : null,
  };
  const ref = {
    get: async () => ({ exists: Boolean(record), data: () => ({ ...record }) }),
  };
  const db = {
    collection: collection => {
      assert.equal(collection, 'nativeWorkflowExecutions');
      return {
        doc: name => {
          assert.equal(name, execId);
          return ref;
        },
      };
    },
    runTransaction: async callback => callback({
      get: async r => r.get(),
      update: (_r, value) => { record = { ...record, ...value }; },
    }),
  };
  return {
    db,
    userId: 'verified-user',
    projectId: 'project-a',
    execId,
    get: () => record,
  };
}

test('native executions use the existing Workflows status and cancellation contract', async () => {
  const f = fixture();
  assert.equal(isNativeExecutionId(f.execId), true);
  assert.equal(isNativeExecutionId('projects/example/executions/123'), false);
  assert.deepEqual(await nativeExecutionStatus(f), {
    id: f.execId,
    data: { status: 'Running', workflow: 'NativePilot', updated: 1234 },
  });
  assert.deepEqual(await cancelNativeExecution(f), {
    status: 200,
    body: { results: [{ execId, cancelled: true, backend: 'native' }] },
  });
  assert.equal(f.get().status, 'cancelled');
  assert.equal(f.get().epoch, 2);
  assert.equal((await nativeExecutionStatus(f)).data.status, 'Cancelled');
});

test('completed native executions return a result and cannot be cancelled', async () => {
  const f = fixture('completed');
  assert.deepEqual((await nativeExecutionStatus(f)).data, {
    status: 'Succeeded', workflow: 'NativePilot',
    updated: 1234, result: { ok: true },
  });
  await assert.rejects(cancelNativeExecution(f), /execution already completed/);
});

test('native status and cancellation do not reveal another user or project', async () => {
  const f = fixture();
  for (const scope of [
    { ...f, userId: 'forged' },
    { ...f, projectId: 'wrong-project' },
  ]) {
    await assert.rejects(nativeExecutionStatus(scope),
      { code: 'NOT_FOUND' });
    await assert.rejects(cancelNativeExecution(scope),
      { code: 'NOT_FOUND' });
  }
  assert.equal(f.get().status, 'ready');
});


test('failed native executions are terminal and visible only to their owner', async () => {
  const f = fixture('failed');
  assert.deepEqual((await nativeExecutionStatus(f)).data, {
    status: 'Failed', workflow: 'NativePilot', updated: 1234, error: undefined,
  });
  await assert.rejects(cancelNativeExecution(f), /already failed/);
  await assert.rejects(nativeExecutionStatus({ ...f, userId: 'other' }),
    { code: 'NOT_FOUND' });
});
