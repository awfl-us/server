import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executionFailureResponse } from './executionFailureResponse.js';

test('native session-busy failure produces HTTP 409 with a usable retry message', () => {
  const outcome = executionFailureResponse({ executionName: 'native/test',
    state: 'FAILED', error: { code: 409,
      message: 'Session is busy; retry after the active turn completes' } });
  assert.deepEqual(outcome, { status: 409, body: {
    executionName: 'native/test', state: 'FAILED', code: 409,
    retryable: true,
    error: 'Session is busy; retry after the active turn completes',
  } });
});

test('other failed and cancelled executions keep non-retryable error semantics', () => {
  assert.deepEqual(executionFailureResponse({executionName:'native/x',state:'FAILED',
    error:{code:422,message:'HTTP 422'}}),{status:500,body:{
      executionName:'native/x',state:'FAILED',error:'HTTP 422'}});
  assert.deepEqual(executionFailureResponse({executionName:'gcp/x',state:'CANCELLED',
    error:{}}),{status:500,body:{executionName:'gcp/x',
      state:'CANCELLED',error:'Execution did not succeed'}});
});
