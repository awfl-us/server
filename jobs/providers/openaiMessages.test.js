import test from 'node:test';
import assert from 'node:assert/strict';
import { toOpenAiMessages } from './openaiMessages.js';

test('drops AWFL timestamps and document identifiers but preserves content', () => {
  const text = '[Preload] Static AWFL instructions repeated for prompt caching.';
  const before = [
    {role: 'system', content: text, create_time: 1711, docId: 'msg-1'},
    {role: 'assistant', content: null,
      tool_calls: [{id: 'call-1', type: 'function', function: {name: 'READ_FILE', arguments: '{}'}}],
      create_time: 1712, docId: 'msg-2'},
    {role: 'tool', tool_call_id: 'call-1', content: 'result', create_time: 1713}
  ];
  const after = toOpenAiMessages(before);
  assert.deepEqual(after, [
    {role: 'system', content: text},
    {role: 'assistant', content: null,
      tool_calls: [{id: 'call-1', type: 'function', function: {name: 'READ_FILE', arguments: '{}'}}]},
    {role: 'tool', tool_call_id: 'call-1', content: 'result'}
  ]);
  assert.equal(before[0].create_time, 1711, 'stored messages remain untouched');
  assert.notStrictEqual(after[0], before[0], 'transport messages are copies');
});

test('two system messages that vary only by timestamp become identical', () => {
  const text = 'A static preload of 15000 characters: ' + 'static.'.repeat(2200);
  const a = [{role: 'system', content: text, create_time: 1, docId: 'a'}];
  const b = [{role: 'system', content: text, create_time: 2, docId: 'b'}];
  assert.notEqual(JSON.stringify(a), JSON.stringify(b));
  assert.equal(JSON.stringify(toOpenAiMessages(a)), JSON.stringify(toOpenAiMessages(b)));
});

test('does not mutate message content blocks or turn null inputs into empty prompts', () => {
  const content = [{type: 'text', text: 'reference', prompt_cache_breakpoint: {mode: 'explicit'}}];
  const messages = [{role: 'system', content, create_time: 12}];
  assert.strictEqual(toOpenAiMessages(messages)[0].content, content);
  assert.equal(toOpenAiMessages(null), null);
});
