import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createExecutionBudget, runNativeWorkflow } from './worker.js';

test('shared native permit budget never over-admits on release and immediate new arrival', async () => {
  const budget = createExecutionBudget(2);
  let active = 0, peak = 0;
  const gates = [];
  const enter = () => budget(async () => {
    active++;
    peak = Math.max(active, peak);
    await new Promise(resolve => gates.push(resolve));
    active--;
  });
  const first = enter(), second = enter(), third = enter(), fourth = enter();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gates.length, 2);
  gates.shift()();
  const fifth = enter(); // Competes with the released waiter's continuation.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gates.length, 2, 'only one waiter inherits the released permit');
  assert.equal(peak, 2, 'new arrivals cannot exceed bounded concurrency');
  for (let i = 0; i < 3; i++) {
    gates.shift()();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(active <= 2);
  }
  gates.shift()();
  await Promise.all([first, second, third, fourth, fifth]);
  assert.equal(active, 0);
  assert.equal(peak, 2);
  assert.throws(() => createExecutionBudget(0), /positive capacity/);
});

const binaryPath = process.env.AWFL_NATIVE_V2_NESTED_RANGE_BINARY;
test('real Rust worker completes eight pinned effects with trusted user and project', {
  skip: !binaryPath, timeout: 120_000,
}, async () => {
  const sha256 = createHash('sha256').update(await readFile(binaryPath)).digest('hex');
  const identity = { userId: 'verified-user', projectId: 'project-a' };
  const state = {
    executionId: 'native_' + 'a'.repeat(32), ...identity,
    workflowName: 'NativePilot', artifactSha256: sha256,
    protocolVersion: 2, allowedOperations: ['http.post'],
    status: 'ready', input: { env: identity },
    owner: null, epoch: 0, leaseUntil: 0,
    checkpoint: null, pendingEffect: null, effectCount: 0,
  };
  const journal = new Map();
  const store = {
    get: async () => ({ ...state }),
    claim: async ({ workerId }) => {
      if (state.status === 'completed') return { completed: true, result: state.result };
      if (state.owner && state.owner !== workerId) throw new Error('lease held');
      state.owner = workerId;
      if (!state.epoch) state.epoch++;
      state.leaseUntil = Date.now() + 60_000;
      return { ...state };
    },
    prepareEffect: async ({ effectId, nodeId, operation, args, continuation, resultSlot }) => {
      assert.equal(state.pendingEffect, null);
      state.status = 'waiting_effect';
      state.pendingEffect = {
        effectId, nodeId, operation, args,
        fingerprint: effectId, preparedAt: Date.now(), resultSlot,
      };
      state.checkpoint = continuation;
    },
    recordEffect: async ({ effectId, outcome }) => {
      assert.equal(state.pendingEffect.effectId, effectId);
      journal.set(effectId, outcome);
      state.checkpoint.slots[state.pendingEffect.resultSlot] = {
        type: 'string', value: outcome,
      };
      state.pendingEffect = null;
      state.status = 'ready';
      state.effectCount++;
    },
    complete: async ({ result }) => {
      state.status = 'completed';
      state.result = result;
    },
  };
  let sent = 0;
  const handlers = { 'http.post': async ({ args, identity: granted }) => {
    assert.deepEqual(granted, identity);
    if (sent % 2 === 0) assert.deepEqual(args, {
      url: 'https://example.org/nested-range',
    });
    else assert.equal(args, 'first-' + Math.floor(sent / 4) + '-' + Math.floor((sent % 4) / 2));
    const response = (sent % 2 ? 'second-' : 'first-') +
      Math.floor(sent / 4) + '-' + Math.floor((sent % 4) / 2);
    sent++;
    return response;
  } };
  const result = await runNativeWorkflow({
    store,
    releases: { materialize: async () => ({
      executable: binaryPath, sha256, cleanup: async () => {},
    }) },
    executionId: state.executionId, ...identity, handlers,
    workerId: 'worker_a',
  });
  assert.deepEqual(result, [['second-0-0', 'second-0-1'], ['second-1-0', 'second-1-1']]);
  assert.equal(state.status, 'completed');
  assert.equal(sent, 8);
  assert.equal(journal.size, 8);
  assert.deepEqual(await runNativeWorkflow({
    store, releases: { materialize: async () => {
      throw new Error('must not redownload completed artifact');
    } },
    executionId: state.executionId, ...identity, handlers, workerId: 'worker_b',
  }), result);
  await assert.rejects(runNativeWorkflow({
    store, releases: {}, executionId: state.executionId,
    userId: 'spoofed', projectId: 'project-a', handlers,
  }), /does not match trusted Jobs task identity/);
});

test('native worker rejects project impersonation before loading an artifact', async () => {
  let fetched = 0;
  await assert.rejects(runNativeWorkflow({
    executionId: 'native_a', userId: 'owner', projectId: 'wrong',
    store: { get: async () => ({
      userId: 'owner', projectId: 'correct', protocolVersion: 2,
    }) },
    releases: { materialize: async () => { fetched++; } },
    handlers: {},
  }), /does not match trusted Jobs task identity/);
  assert.equal(fetched, 0);
});
