import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateOpenAiCost } from './cost.js';

const sol = { prompt: 2.00, cached: 0.20, completion: 10.00 };

test('uncached GPT-6 Sol pricing', () => {
  assert.equal(calculateOpenAiCost(sol, { prompt_tokens: 10_000, completion_tokens: 2_000 }), 0.04);
});

test('cached prompt tokens replace rather than add input token cost', () => {
  const result = calculateOpenAiCost(sol, {
    prompt_tokens: 10_000,
    prompt_tokens_details: {cached_tokens: 6_000},
    completion_tokens: 2_000
  });
  assert.ok(Math.abs(result - 0.0292) < 1e-12);
});

test('unexpected cached counts cannot overcharge', () => {
  assert.ok(Math.abs(calculateOpenAiCost(sol, {
    prompt_tokens: 100, prompt_tokens_details: {cached_tokens: 300},
    completion_tokens: 0
  }) - 0.00002) < 1e-12);
});

test('absent usage gives no cost', () => {
  assert.equal(calculateOpenAiCost(sol, null), null);
});
