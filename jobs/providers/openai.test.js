import test from 'node:test';
import assert from 'node:assert/strict';
import { chat } from './openai.js';

test('OpenAI adapter uses native fetch and preserves chat completion payload and result', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({
      id: 'chatcmpl-test',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await chat({
      apiKey: 'sk-test-only', model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Reply OK' }],
      max_tokens: 16,
    });
    assert.equal(result.message.content, 'OK');
    assert.equal(result.usage.total_tokens, 10);
    assert.equal(requests.length, 1, 'SDK must call the native fetch provided at construction');
    assert.match(requests[0].url, /\/v1\/chat\/completions$/);
    const body = JSON.parse(requests[0].init.body);
    assert.equal(body.model, 'gpt-4o-mini');
    assert.equal(body.max_completion_tokens, 16);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
