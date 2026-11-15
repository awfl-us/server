import test from 'node:test';
import assert from 'node:assert/strict';
import { PilotLatency } from '../../storage/pilot/metrics.js';

test('failed database operations are excluded from latency percentiles', async () => {
  const metrics = new PilotLatency();
  await assert.rejects(metrics.measure('create', async () => { throw new Error('PERMISSION_DENIED'); }));
  const denied = metrics.report().create;
  assert.equal(denied.n, 0);
  assert.equal(denied.errors, 1);
  assert.equal(denied.p50, null);
  await metrics.measure('create', async () => 'okay');
  const recovered = metrics.report().create;
  assert.equal(recovered.n, 1);
  assert.equal(recovered.errors, 1);
  assert.ok(Number.isFinite(recovered.p50));
});
