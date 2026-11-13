import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeProgressWriter } from './progressWriter.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('coalesces pending snapshots and never overlaps writes', async () => {
  const writes = [];
  let release;
  const writer = createNativeProgressWriter(async snapshot => {
    writes.push(snapshot.sequence);
    await new Promise(resolve => { release = resolve; });
  }, { intervalMs: 1 });
  writer.publish({ sequence: 1 });
  await sleep(12);
  assert.deepEqual(writes, [1]);
  writer.publish({ sequence: 2 });
  writer.publish({ sequence: 3 });
  release();
  await sleep(12);
  assert.deepEqual(writes, [1, 3], 'only the latest queued snapshot survives');
  const finishing = writer.close();
  release();
  await finishing;
  assert.throws(() => writer.publish({ sequence: 4 }), /closed/);
});

test('terminal close discards unsent progress; cannot overwrite a completed result', async () => {
  const writes = [];
  const writer = createNativeProgressWriter(async x => writes.push(x),
    { intervalMs: 10_000 });
  writer.publish({ step: 1 });
  await writer.close();
  assert.deepEqual(writes, []);
});

test('background write failures do not block workflow, later snapshots can retry', async () => {
  let attempts = 0;
  const writer = createNativeProgressWriter(async () => {
    attempts++;
    if (attempts === 1) throw new Error('Firestore transient outage');
  }, { intervalMs: 5 });
  writer.publish({ step: 1 });
  await sleep(35);
  const { failures } = await writer.close();
  assert.equal(failures, 1);
  assert.ok(attempts >= 2);
});
