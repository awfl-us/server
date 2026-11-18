import test from 'node:test';
import assert from 'node:assert/strict';
import { sizeLimiter } from './sizeLimiter.js';

test('model-aware size limiter retains history for Terra but trims with legacy defaults', () => {
  const messages = Array.from({ length: 15 }, (_, n) => ({
    role: n % 2 ? 'assistant' : 'user', content: String(n) + 'X'.repeat(8000)
  }));
  const opts = { maxContentChars: 1000000, prioritizeUser: false };
  assert.equal(sizeLimiter(messages, opts, { llmModel: 'gpt-6.1-terra' }).length, 15);
  assert.ok(sizeLimiter(messages, opts).length < 15);
  assert.ok(sizeLimiter(messages, opts, { llmModel: 'gpt-4o' }).length < 15);
  assert.ok(sizeLimiter(messages, { ...opts, maxTokens: 15000 },
    { llmModel: 'gpt-6.1-terra' }).length < 15);
});

test('a custom Terra filter cannot exceed the configured model budget', () => {
  const messages = [{ role: 'user', content: 'X'.repeat(440000) }];
  const opts = { maxContentChars: 1000000, maxTokens: 500000 };
  assert.equal(sizeLimiter(messages, opts, { llmModel: 'gpt-6.1-terra' }).length, 0);
});
