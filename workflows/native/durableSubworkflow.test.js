import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDurableSubworkflowHandler } from './durableSubworkflow.js';
import { NativeConfirmedWorkflowFailure } from './effectErrors.js';
// Exercises the explicit local/test transport; production requires GKE opt-in.
process.env.NODE_ENV = 'test';

const executionId = 'native_' + 'f'.repeat(32);
const identity = { userId: 'real-owner', projectId: 'project' };
const digest = 'a'.repeat(64);

function fixture({
  parallel = false, missing = false, failChild = false, store, scheduleAsync,
  getProjectStorage, effectHandlers = {}, artifactRun, allowedOperations = [],
} = {}) {
  const calls = { active: [], materialize: [], cleanup: 0, invoked: [] };
  const releases = {
    async active(name) {
      calls.active.push(name);
      return missing ? null : {
        protocolVersion: 2, workflowName: name, sha256: digest,
        trustedGlobalsVersion: 1,
        allowedOperations: parallel ? ['native.parallel'] : allowedOperations,
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
    releases, handlers: effectHandlers, runArtifact: artifactRun || runArtifact,
    executionId,
    ...identity, gcpProject: 'awfl-us', region: 'us-central1',
    store, scheduleAsync, getProjectStorage,
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
    assert.equal(record.detachedParentExecutionId, executionId);
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


test('durable benchmark child executes effects in an owned temporary project', async () => {
  const seen = [], checked = [];
  const { handler } = fixture({
    allowedOperations: ['http.post'],
    getProjectStorage: async () => ({
      get: async path => {
        checked.push(path);
        return path === 'users/real-owner/projects/tmp-project'
          ? { data: { id: 'tmp-project' } } : null;
      },
    }),
    effectHandlers: {
      'http.post': async ({ identity: target }) => {
        seen.push(target);
        return { code: 200, body: {} };
      },
    },
    artifactRun: async ({ input }) => input.continuation
      ? { protocol_version: 2, status: 'completed', result: 'ok' }
      : { protocol_version: 2, status: 'suspended',
        effect: { operation: 'http.post', effect_id: 'tool_1', node_id: '1',
          args: { url: 'https://jobs.example.org/agents/session/create' },
          result_slot: 's0' },
        continuation: { next_step: 1, slots: {}, frames: [] } },
  });
  const scopedArgs = { ...args, argument: {
    env: { userId: identity.userId, projectId: 'tmp-project' },
  } };
  try {
    assert.equal(await handler.run({
      args: scopedArgs, identity, idempotencyKey: executionId + ':temporary',
    }), 'ok');
    assert.deepEqual(checked, [
      'users/real-owner/projects/tmp-project',
      'users/real-owner/projects/tmp-project',
    ]);
    assert.deepEqual(seen, [{ userId: 'real-owner', projectId: 'tmp-project' }]);
  } finally { await handler.close(); }
});

test('detached child inside an owned ProjectManager keeps the temporary project scope', async () => {
  const records = new Map(), scheduled = [];
  const store = {
    create: async value => { records.set(value.executionId, value); },
    get: async id => records.get(id),
  };
  const { handler } = fixture({
    store, scheduleAsync: req => scheduled.push(req),
    allowedOperations: ['workflow.run'],
    getProjectStorage: async () => ({
      get: async path => path === 'users/real-owner/projects/tmp-project'
        ? { data: { id: 'tmp-project' } } : null,
    }),
    artifactRun: async ({ input }) => input.continuation
      ? { protocol_version: 2, status: 'completed', result: 'done' }
      : { protocol_version: 2, status: 'suspended',
        effect: {
          operation: 'workflow.run', effect_id: 'async_1', node_id: '1',
          args: {
            workflow_id: 'BackgroundAgent',
            argument: { query: 'synthetic' },
            project_id: 'awfl-us', location: 'us-central1',
            connector_params: { skip_polling: true },
          },
          result_slot: 's0',
        },
        continuation: { next_step: 1, slots: {}, frames: [] } },
  });
  try {
    const outcome = await handler.run({
      args: { ...args, argument: {
        env: { userId: 'real-owner', projectId: 'tmp-project' },
      } },
      identity, idempotencyKey: executionId + ':nested-parent',
    });
    assert.equal(outcome, 'done');
    assert.equal(records.size, 1);
    const [child] = records.values();
    assert.equal(child.projectId, 'tmp-project');
    assert.equal(child.userId, 'real-owner');
    assert.deepEqual(scheduled, [{
      executionId: child.executionId,
      userId: 'real-owner', projectId: 'tmp-project',
    }]);
  } finally { await handler.close(); }
});

test('durable child cannot switch to another user or an unowned project', async () => {
  const { handler, calls } = fixture({
    getProjectStorage: async () => ({ get: async () => null }),
  });
  try {
    for (const env of [
      { userId: 'attacker', projectId: 'tmp-project' },
      { userId: identity.userId, projectId: 'unowned' },
    ]) {
      await assert.rejects(handler.run({
        args: { ...args, argument: { env } },
        identity, idempotencyKey: executionId + ':unauthorized',
      }), /not owned|may not switch authenticated user/);
    }
    assert.equal(calls.materialize.length, 0);
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
