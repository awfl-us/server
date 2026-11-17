import test from 'node:test';
import assert from 'node:assert/strict';
import { chat, buildChatPayload } from './openai.js';

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


const functionTools = [{
  type: 'function', function: {
    name: 'list_directories', description: 'List directories',
    parameters: { type: 'object', properties: {} }
  }
}];

test('GPT-6 Sol function calls use no reasoning on Chat Completions', () => {
  const payload = buildChatPayload({
    model: 'gpt-6-sol', messages: [{ role: 'user', content: 'Inspect' }],
    tools: functionTools, tool_choice: 'auto', temperature: 0.7,
    max_tokens: 1000
  });
  assert.equal(payload.reasoning_effort, 'none');
  assert.equal(payload.temperature, undefined);
  assert.deepEqual(payload.tools, functionTools);
  assert.equal(payload.tool_choice, 'auto');
  assert.equal(payload.max_completion_tokens, 1000);
});

test('other models preserve their parameters', () => {
  const payload = buildChatPayload({
    model: 'gpt-5.5', messages: [], tools: functionTools,
    temperature: 1, max_tokens: 500,
    response_format: { type: 'json_object' }
  });
  assert.equal(payload.reasoning_effort, undefined);
  assert.equal(payload.temperature, 1);
  assert.deepEqual(payload.response_format, { type: 'json_object' });
  assert.equal(payload.max_completion_tokens, 500);
});

test('Sol without tools has no forced reasoning effort', () => {
  const payload = buildChatPayload({
    model: 'gpt-6-sol', messages: [], tools: [], temperature: 0.5
  });
  assert.equal(payload.reasoning_effort, undefined);
  assert.equal(payload.temperature, undefined);
});
