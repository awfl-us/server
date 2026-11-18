import { test } from 'node:test';
import assert from 'node:assert/strict';
import { llmFailureResponse } from './transportError.js';

test('exhausted OpenAI credits become non-retryable HTTP 429 rather than 500', () => {
  const result = llmFailureResponse({
    status: 429, code: 'credit_balance_exhausted', type: 'insufficient_quota',
    message: 'You have no credits remaining',
  });
  assert.deepEqual(result, {
    status: 429,
    body: {
      error: 'LLM provider credits exhausted',
      code: 'credit_balance_exhausted',
      retryable: false,
    },
  });
});

test('other rate limits and internal failures preserve existing status behavior', () => {
  assert.equal(llmFailureResponse({
    status: 429, code: 'rate_limit_exceeded', message: 'Slow down',
  }).status, 500);
  assert.deepEqual(llmFailureResponse(new Error('Internal error')), {
    status: 500, body: { error: 'Failed to complete chat request: Internal error' },
  });
});
