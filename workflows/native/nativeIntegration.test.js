// Run with AWFL_NATIVE_FIXTURE_BINARY set to a compiled compiler-rust fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { runNativeArtifact, executePureNative } from './runner.js';

const executable = process.env.AWFL_NATIVE_FIXTURE_BINARY;
test('actual Scala-generated Rust fold binary executes through server runner', { skip: !executable }, async () => {
  const sha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
  for (const [input, expected] of [[[1, 2, 3], 16], [[], 10], [[-4, 5], 11]]) {
    assert.equal(await runNativeArtifact({ executable, sha256, input }), expected);
  }
  const events = [];
  const store = {
    claim: async () => ({ epoch: 7, artifactSha256: sha256, input: [1, 2, 3] }),
    complete: async args => events.push(args),
  };
  const response = await executePureNative({ store, executionId: 'real_rust', workerId: 'w1', executable, sha256 });
  assert.deepEqual(response, { completed: true, result: 16 });
  assert.deepEqual(events, [{ executionId: 'real_rust', workerId: 'w1', epoch: 7, result: 16 }]);
});
