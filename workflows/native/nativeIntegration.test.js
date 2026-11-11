// Run with AWFL_NATIVE_FIXTURE_BINARY set to a compiled compiler-rust fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { runNativeArtifact, executePureNative } from './runner.js';
import { runNativeWorkflow } from './worker.js';

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

// Set this to a Scala-generated ABI 3 / protocol-v2 pure binary, including
// the content-addressed NativePilot executable published to GCS. This test
// exercises the actual Jobs worker protocol, not the legacy JSON-only runner.
const pureV2 = process.env.AWFL_NATIVE_PILOT_BINARY;
test('published ABI 3 Rust binary completes and replays through native Jobs worker',
  { skip: !pureV2 }, async () => {
    const sha256 = createHash('sha256').update(await readFile(pureV2)).digest('hex');
    const executionId = 'native_' + 'e'.repeat(32);
    const identity = { userId: 'verified-user', projectId: 'project-a' };
    const state = {
      executionId, ...identity, workflowName: 'NativePilot',
      artifactSha256: sha256, protocolVersion: 2,
      allowedOperations: [], status: 'ready', input: { env: identity },
      epoch: 0, owner: null, checkpoint: null, pendingEffect: null,
    };
    let claims = 0, completions = 0, downloads = 0;
    const store = {
      get: async () => ({ ...state }),
      claim: async ({ workerId }) => {
        claims++;
        state.owner = workerId;
        state.epoch++;
        return { ...state };
      },
      complete: async ({ executionId: completedId, epoch, result }) => {
        assert.equal(completedId, executionId);
        assert.equal(epoch, state.epoch);
        completions++;
        state.status = 'completed';
        state.result = result;
      },
    };
    const releases = {
      materialize: async digest => {
        assert.equal(digest, sha256);
        downloads++;
        return { executable: pureV2, sha256, cleanup: async () => {} };
      },
    };
    const options = { store, releases, executionId, ...identity, handlers: {} };
    const expected = [2, 3, 9, 9];
    assert.deepEqual(await runNativeWorkflow(options), expected);
    assert.equal(state.status, 'completed');
    assert.equal(claims, 1);
    assert.equal(completions, 1);
    assert.equal(downloads, 1);

    // Cloud Tasks may redeliver a completed execution. The worker must
    // return its recorded result without rerunning or downloading the ELF.
    assert.deepEqual(await runNativeWorkflow(options), expected);
    assert.equal(claims, 1);
    assert.equal(completions, 1);
    assert.equal(downloads, 1);
    await assert.rejects(runNativeWorkflow({
      ...options, userId: 'another-user',
    }), /does not match trusted Jobs task identity/);
    assert.equal(downloads, 1);
  });
