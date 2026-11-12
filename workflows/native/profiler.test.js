import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeProfiler } from './profiler.js';

test('disabled native profiling adds no instrumentation and logs nothing', async () => {
  assert.equal(createNativeProfiler({ enabled: false }), null);
});

test('native profiling uses fixed method names, measures success/failure, never logs arguments', async () => {
  const logs = [];
  const profiler = createNativeProfiler({ enabled: true,
    executionId: 'native_' + 'a'.repeat(32),
    logger: { info: value => logs.push(value) },
  });
  const secret = 'sensitive-token-do-not-log';
  const store = profiler.store({
    get: async ({ token }) => { assert.equal(token, secret); return { ok: true }; },
    claim: async () => { throw new Error(secret); },
  });
  const releases = profiler.releases({
    materialize: async () => ({ sha256: 'abc' }),
  });
  const handlers = profiler.handlers({
    'http.get': async ({ url }) => { assert.equal(url, secret); return { code: 200 }; },
  });
  assert.deepEqual(await store.get({ token: secret }), { ok: true });
  await assert.rejects(store.claim(), /sensitive-token/);
  assert.deepEqual(await releases.materialize('irrelevant'), { sha256: 'abc' });
  assert.deepEqual(await handlers['http.get']({ url: secret }), { code: 200 });
  await profiler.measure('runner.transition', async () => {});
  profiler.report('completed');
  assert.equal(logs.length, 1);
  const result = logs[0];
  assert.equal(result.event, 'awfl_native_job_timing');
  assert.deepEqual(Object.keys(result.phases).sort(), [
    'effect.http.get', 'firestore.claim', 'firestore.get', 'gcs.materialize',
    'runner.transition',
  ]);
  for (const value of Object.values(result.phases)) {
    assert.equal(value.count, 1);
    assert.ok(value.totalMs >= 0);
  }
  assert.equal(JSON.stringify(result).includes(secret), false);
});
