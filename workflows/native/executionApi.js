// Native execution read/cancel adapters for the EXISTING Workflows API.
// No direct user-facing native execution or deployment endpoint.
import { NativeExecutionStore } from './executionStore.js';

const ID = /^native_[a-f0-9]{32}$/;

export const isNativeExecutionId = id => typeof id === 'string' && ID.test(id);

function assertOwner(state, { userId, projectId }) {
  if (!state || state.userId !== userId || state.projectId !== projectId) {
    // Avoid leaking whether another user's execution ID exists.
    throw Object.assign(new Error('native execution not found'), { code: 'NOT_FOUND' });
  }
}

export async function nativeExecutionStatus({ db, execId, userId, projectId }) {
  if (!isNativeExecutionId(execId)) throw new Error('invalid native execution ID');
  const store = new NativeExecutionStore({ db });
  const state = await store.get(execId);
  assertOwner(state, { userId, projectId });
  const status = state.status === 'completed' ? 'Succeeded'
    : state.status === 'cancelled' ? 'Cancelled' : 'Running';
  return {
    id: execId,
    data: {
      status, workflow: state.workflowName,
      updated: state.updatedAt,
      ...(state.status === 'completed' ? { result: state.result } : {}),
    },
  };
}

export async function cancelNativeExecution({ db, execId, userId, projectId }) {
  if (!isNativeExecutionId(execId)) throw new Error('invalid native execution ID');
  const store = new NativeExecutionStore({ db });
  const state = await store.get(execId);
  assertOwner(state, { userId, projectId });
  await store.cancel({ executionId: execId, userId, projectId });
  return {
    status: 200,
    body: {
      results: [{ execId, cancelled: true, backend: 'native' }],
    },
  };
}
