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
    assert.ok(!out.model.filters.some(f => f.name === 'dropToolCallsCompleted'));
    assert.ok(!out.model.filters.some(f => f.name === 'fileContentsLimiter'));
    assert.deepEqual(out.model.components[0], { kind: 'literal', value: 'Hello' });
    assert.equal(decodeContextModel({
      kala: { kind: 'SegKala' },
      model: { components: [], llmModel: 100000 }
    }).model.llmModel, undefined);
  } finally {
    console.log = previousLog;
  }
});

test('TopicContext default filters no longer rewrite tool-completion history', async () => {
  const { applyFilters } = await import('./filters/index.js');
  const previousLog = console.log;
  console.log = () => {};
  try {
    const { model } = decodeContextModel({
      kala: { kind: 'SegKala' },
      presetId: 'TopicContext'
    });
    assert.ok(!model.filters.some(f => f.name === 'fileContentsLimiter'));
    const history = [
      { role: 'user', content: 'Tool calls completed' },
      { role: 'assistant', content: 'Read a file' },
      { role: 'user', content: 'Tool calls completed' },
    ];
    // Other filters can limit history when configured to do so; this short
    // history must not undergo phrase-specific deletion.
    const output = await applyFilters(history, model.filters);
    assert.equal(output.filter(m => m.content === 'Tool calls completed').length, 2);
  } finally {
    console.log = previousLog;
  }
});


test('TopicContext retains historical file content when within the token budget', async () => {
  const { applyFilters } = await import('./filters/index.js');
  const previousLog = console.log;
  console.log = () => {};
  try {
    const { model } = decodeContextModel({kala:{kind:'SegKala'},presetId:'TopicContext'});
    const history = Array.from({length:9}, (_,i) => ({
      role:'tool', tool_call_id:`call_${i}`,
      content:JSON.stringify({filepath:`/tmp/file${i}.txt`,content:`file ${i} contents`})
    }));
    // Check the filtering stage before the separate tool-chain backfill
    // (which can reclassify orphaned tools in isolation).
    const preBackfill = model.filters.filter(f=>f.name!=='toolCallBackfill');
    const out = await applyFilters(history,preBackfill);
    assert.deepEqual(out.map(m=>m.content),history.map(m=>m.content));
  } finally {console.log=previousLog;}
});
