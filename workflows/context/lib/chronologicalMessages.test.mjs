import test from 'node:test';
import assert from 'node:assert/strict';
import { interleaveContextMessages, timestampContextMessage } from './chronologicalMessages.js';

function record(label, time, role = 'system') {
  return timestampContextMessage({ role, content: label }, time);
}

test('interleaves summaries, topics, and chat by their stored creation times', () => {
  const incoming = [record('summary 100', 100), record('summary 300', 300),
    record('topic 175', 175), record('chat 50', 50, 'user'),
    record('chat 250', 250, 'assistant'), record('chat 500', 500, 'tool')];
  assert.deepEqual(interleaveContextMessages(incoming).map(m => m.content), [
    'chat 50', 'summary 100', 'topic 175', 'chat 250', 'summary 300', 'chat 500',
  ]);
  // Timestamps are internal; no extra payload fields should reach OpenAI.
  assert.deepEqual(Object.keys(incoming[0]), ['role', 'content']);
  assert.equal(JSON.stringify(incoming[0]), '{"role":"system","content":"summary 100"}');
});

test('preserves source order for identical timestamps and repeated calls', () => {
  const messages = [record('summary', 100), record('topic', 100),
    record('chat', 100, 'user'), record('later', 110)];
  for (let n = 0; n < 2; n++) {
    assert.deepEqual(interleaveContextMessages(messages).map(m => m.content),
      ['summary', 'topic', 'chat', 'later']);
  }
});

test('keeps literal, missing, and malformed-timestamp messages in place', () => {
  const literal = { role: 'system', content: 'literal' };
  const missing = { role: 'user', content: 'missing' };
  const messages = [literal, record('later', 300), missing,
    record('invalid', undefined), record('early', 100), record('nan', NaN)];
  assert.deepEqual(interleaveContextMessages(messages).map(m => m.content),
    ['literal', 'early', 'missing', 'invalid', 'later', 'nan']);
});

test('a newly appended later chat message does not change the previous prefix', () => {
  const messages = [record('summary old', 100), record('summary new', 200),
    record('chat older', 150, 'user'), record('chat latest', 300, 'assistant')];
  const before = interleaveContextMessages(messages);
  const after = interleaveContextMessages([...messages, record('next', 400, 'user')]);
  assert.deepEqual(after.slice(0, before.length), before);
});

test('accepts numeric timestamps from storage without sorting invalid dates', () => {
  const messages = [record('string timestamp', '300'), record('number timestamp', 100),
    record('invalid blank timestamp', ''), record('zero timestamp', 0)];
  assert.deepEqual(interleaveContextMessages(messages).map(m => m.content),
    ['zero timestamp', 'number timestamp', 'invalid blank timestamp', 'string timestamp']);
});
