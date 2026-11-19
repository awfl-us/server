import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TOKENS, resolveMaxTokens, resolveContextMessageBudget, checkModelContextWindow
} from './modelConfig.js';

test('existing completion defaults remain intact', () => {
  assert.equal(resolveMaxTokens('gpt-6.1-terra'), 128000);
  assert.equal(resolveMaxTokens('gpt-4o'), 16384);
  assert.equal(resolveMaxTokens('unconfigured-model'), 16384);
  assert.equal(MAX_TOKENS['gpt-5.5'], 128000);
});

test('Terra receives a 17K context-message budget for threshold testing', () => {
  assert.equal(resolveContextMessageBudget('gpt-6.1-terra'), 17000);
  assert.equal(resolveContextMessageBudget('gpt-6.1-terra', 200000), 17000);
  assert.equal(resolveContextMessageBudget('gpt-6.1-terra', 12000), 12000);
  assert.equal(resolveContextMessageBudget('gpt-4o'), 17000);
  assert.equal(resolveContextMessageBudget(), 17000);
  assert.equal(resolveContextMessageBudget('gpt-4o', 24000), 24000);
});

test('Terra context-window preflight includes tool schemas and output reservation', () => {
  const small = checkModelContextWindow('gpt-6.1-terra', {
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ type: 'function', function: { name: 'test', parameters: {} } }],
    maxCompletionTokens: 128000
  });
  assert.equal(small.ok, true);
  const oversized = checkModelContextWindow('gpt-6.1-terra', {
    messages: [{ role: 'user', content: 'A'.repeat(950000) }],
    maxCompletionTokens: 128000
  });
  assert.equal(oversized.ok, false);
  assert.match(oversized.reason, /context window/);
  assert.equal(checkModelContextWindow('gpt-6.1-terra', {
    messages: [], maxCompletionTokens: 128001
  }).ok, false);
});
