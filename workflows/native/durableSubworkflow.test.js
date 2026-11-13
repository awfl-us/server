import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDurableSubworkflowHandler } from './durableSubworkflow.js';
import { NativeConfirmedWorkflowFailure } from './effectErrors.js';
// Exercises the explicit local/test transport; production requires GKE opt-in.
process.env.NODE_ENV = 'test';

const executionId = 'native_' + 'f'.repeat(32);
const identity = { userId: 'real-owner', projectId: 'project' };
const digest = 'a'.repeat(64);

function fixture({ parallel = false, missing = false, failChild = false, store, scheduleAsync } = {}) {
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
    if (failChild) return { protocol_version: 2, status: 'failed',
      error: { message: 'missing field or element: workdir' } };
    return { protocol_version: 2, status: 'completed',
      result: { actual: true, input: request.input.input } };
  };
  const handler = createDurableSubworkflowHandler({
    releases, handlers: {}, runArtifact, executionId,
    ...identity, gcpProject: 'awfl-us', region: 'us-central1',
    store, scheduleAsync,
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

test('detached workflow.run persists and schedules one independent parallel-capable execution', async () => {
  const records = new Map(), scheduled = [];
  const store = {
    async create(record) {
      if (records.has(record.executionId)) {
        throw Object.assign(new Error('exists'), { code: 'CONFLICT' });
      }
      records.set(record.executionId, structuredClone(record));
    },
    async get(id) { return records.get(id); },
  };
  const { handler, calls } = fixture({ parallel: true, store,
    scheduleAsync: req => scheduled.push(req) });
  const detached = {
    ...args, workflow_id: 'codebase-ProjectManager${WORKFLOW_ENV}',
    connector_params: { skip_polling: true },
  };
  const key = executionId + ':toolCallsCompleted';
  try {
    const first = await handler.run({ args: detached, identity, idempotencyKey: key });
    assert.equal(first.state, 'ACTIVE');
    assert.match(first.name, /^native\/native_[a-f0-9]{32}$/);
    assert.deepEqual(Object.keys(first).sort(), ['name', 'state']);
    assert.equal(calls.materialize.length, 0, 'no inline child execution');
    assert.equal(records.size, 1, 'one independent execution persisted');
    const id = first.name.slice('native/'.length);
    const record = records.get(id);
    assert.deepEqual(record.input, detached.argument);
    assert.equal(record.asyncLaunch, true);
    assert.equal(record.parallelVersion, 1);
    assert.deepEqual(record.allowedOperations, ['native.parallel']);
    assert.equal(record.userId, identity.userId);
    assert.equal(record.projectId, identity.projectId);
    assert.equal(scheduled.length, 1);
    assert.deepEqual(scheduled[0], { executionId: id, ...identity });

    const again = await handler.run({ args: detached, identity, idempotencyKey: key });
    assert.deepEqual(again, first);
    assert.equal(records.size, 1, 'a dispatch retry cannot duplicate a launch');
    assert.equal(scheduled.length, 2, 'a retry may reoffer the same idempotent launch');

    await assert.rejects(handler.run({
      args: { ...detached, argument: { changed: true } },
      identity, idempotencyKey: key,
    }), /idempotency conflict/);
    await assert.rejects(handler.run({
      args: { ...detached, project_id: 'somewhere-else' },
      identity, idempotencyKey: key + ':new',
    }), /unauthorized/);
    assert.equal(records.size, 1);
  } finally { await handler.close(); }
});

test('detached calls refuse unavailable scheduler and invalid connector flags', async () => {
  const { handler } = fixture({ parallel: true });
  try {
    await assert.rejects(handler.run({ args: {
      ...args, connector_params: { skip_polling: true },
    }, identity, idempotencyKey: executionId + ':async' }), /scheduler unavailable/);
    await assert.rejects(handler.run({ args: {
      ...args, connector_params: { skip_polling: 'yes' },
    }, identity, idempotencyKey: executionId + ':bad' }), /unauthorized/);
  } finally { await handler.close(); }
});


test('a pinned child terminal Rust error is classified as confirmed, not a transport retry', async () => {
  const { handler } = fixture({ failChild: true });
  try {
    await assert.rejects(handler.run({
      args, identity, idempotencyKey: executionId + ':child-failed',
    }), error => {
      assert.ok(error instanceof NativeConfirmedWorkflowFailure);
      assert.deepEqual(error.nativeError, { message: 'missing field or element: workdir' });
      return true;
    });
  } finally { await handler.close(); }
});
