import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDurableSubworkflowHandler } from './durableSubworkflow.js';

const executionId = 'native_' + 'f'.repeat(32);
const identity = { userId: 'real-owner', projectId: 'project' };
const digest = 'a'.repeat(64);

function fixture({ parallel = false, missing = false } = {}) {
  const calls = { active: [], materialize: [], cleanup: 0, invoked: [] };
  const releases = {
    async active(name) {
      calls.active.push(name);
      return missing ? null : {
        protocolVersion: 2, workflowName: name, sha256: digest,
        trustedGlobalsVersion: 1,
        allowedOperations: parallel ? ['native.parallel'] : [],
        ...(parallel && { parallelVersion: 1 }),
      };
    },
    async materialize(sha) {
      calls.materialize.push(sha);
      return {
        sha256: sha, executable: '/test/native-child',
        cleanup: async () => { calls.cleanup++; },
      };
    },
  };
  const runArtifact = async request => {
    calls.invoked.push(request);
    assert.equal(request.executable, '/test/native-child');
    return { protocol_version: 2, status: 'completed',
      result: { actual: true, input: request.input.input } };
  };
  const handler = createDurableSubworkflowHandler({
    releases, handlers: {}, runArtifact, executionId,
    ...identity, gcpProject: 'awfl-us', region: 'us-central1',
  });
  return { handler, calls };
}

const args = {
  workflow_id: 'codebase-ProjectManager-prompts${WORKFLOW_ENV}',
  argument: { fund: 1.0, spent: 0.0 },
  project_id: 'awfl-us', location: 'us-central1',
  connector_params: { skip_polling: false },
};

test('durable fork child executes published native binary in-process with caller owner', async () => {
  const { handler, calls } = fixture();
  try {
    const result = await handler.run({
      args, identity, idempotencyKey: executionId + ':fork-1',
    });
    assert.deepEqual(result, { actual: true, input: args.argument });
    assert.deepEqual(calls.active, ['codebase-ProjectManager-prompts']);
    assert.deepEqual(calls.materialize, [digest]);
    assert.match(calls.invoked[0].input.trusted_globals.GOOGLE_CLOUD_WORKFLOW_EXECUTION_ID,
      /^native_[a-f0-9]{32}$/);
  } finally {
    await handler.close();
  }
  assert.equal(calls.cleanup, 1);
});

test('durable child observes deployed workflow suffix without unsafe name parsing', async () => {
  const before = process.env.WORKFLOW_ENV;
  process.env.WORKFLOW_ENV = '-staging';
  const { handler, calls } = fixture();
  try {
    await handler.run({ args, identity, idempotencyKey: executionId + ':fork-2' });
    assert.deepEqual(calls.active, ['codebase-ProjectManager-prompts-staging']);
  } finally {
    await handler.close();
    if (before === undefined) delete process.env.WORKFLOW_ENV;
    else process.env.WORKFLOW_ENV = before;
  }
});

test('reject forged identity, selected project, unpublished child and parallel children', async () => {
  const bad = [
    { args, identity: { userId: 'other', projectId: 'project' },
      idempotencyKey: executionId + ':child' },
    { args: { ...args, project_id: 'another' }, identity,
      idempotencyKey: executionId + ':child' },
    { args: { ...args, workflow_id: '../escape' }, identity,
      idempotencyKey: executionId + ':child' },
  ];
  for (const input of bad) {
    const { handler, calls } = fixture();
    try {
      await assert.rejects(handler.run(input));
      assert.equal(calls.materialize.length, 0);
    } finally { await handler.close(); }
  }
  for (const scenario of [{ missing: true }, { parallel: true }]) {
    const { handler, calls } = fixture(scenario);
    try {
      await assert.rejects(handler.run({
        args, identity, idempotencyKey: executionId + ':child',
      }), /supported published release/);
      assert.equal(calls.materialize.length, 0);
    } finally { await handler.close(); }
  }
});
