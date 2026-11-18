import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeContextModel } from './modelDecoder.js';

test('context model preserves the selected LLM model separately from its schema', () => {
  const previousLog = console.log;
  console.log = () => {};
  try {
    const out = decodeContextModel({
      kala: { kind: 'SegKala' },
      model: {
        llmModel: 'gpt-6.1-terra',
        promoteUpstream: true,
        components: [{ kind: 'literal', value: 'Hello' }]
      }
    });
    assert.equal(out.model.llmModel, 'gpt-6.1-terra');
    assert.ok(out.model.filters.some(f => f.name === 'sizeLimiter'));
    assert.deepEqual(out.model.components[0], { kind: 'literal', value: 'Hello' });
    assert.equal(decodeContextModel({
      kala: { kind: 'SegKala' },
      model: { components: [], llmModel: 100000 }
    }).model.llmModel, undefined);
  } finally {
    console.log = previousLog;
  }
});
