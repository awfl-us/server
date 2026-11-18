import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
const src = readFileSync(new URL('../../jobs/llm/usage.js', import.meta.url), 'utf8');
const code = src.slice(src.indexOf('function toNumber('), src.indexOf('export async function incrementUsage('));
const context = { patch: { increment: n => ({increment:n}) } };
vm.runInNewContext(code + '\nthis.buildUsageIncrements=buildUsageIncrements;', context);
const build = context.buildUsageIncrements;
test('zero cached tokens remain explicitly stored and telemetry coverage counted', () => {
  const result=build({prompt_tokens:1000,prompt_tokens_details:{cached_tokens:0}});
  assert.equal(result['usage.prompt_tokens_details.cached_tokens'].increment,0);
  assert.equal(result['usage.prompt_cache_reported_requests'].increment,1);
  assert.equal(result['usage.prompt_cache_reported_prompt_tokens'].increment,1000);
});
test('missing cache telemetry is distinguishable from explicit zero', () => {
  const result=build({prompt_tokens:1000});
  assert.equal(result['usage.prompt_tokens_details.cached_tokens'],undefined);
  assert.equal(result['usage.prompt_cache_reported_requests'],undefined);
});
test('nonzero cached tokens accumulate normally', () => {
  const result=build({prompt_tokens:1000,prompt_tokens_details:{cached_tokens:256}});
  assert.equal(result['usage.prompt_tokens_details.cached_tokens'].increment,256);
  assert.equal(result['usage.prompt_cache_reported_requests'].increment,1);
});
