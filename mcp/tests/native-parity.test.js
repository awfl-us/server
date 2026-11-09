import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionService, executionIdFor } from '../service.js';

function memoryDb() {
  const data = new Map(), watchers = new Map();
  function doc(path) {
    return {
      path,
      async get() {
        const v = data.get(path);
        return { exists: v !== undefined, data: () => v };
      },
      async set(value, opts) {
        data.set(path, opts?.merge ? { ...data.get(path), ...value } : { ...value });
        for (const listener of watchers.get(path) || []) listener(await this.get());
      },
      async update(value) {
        if (!data.has(path)) throw new Error('Missing document');
        return this.set(value, { merge: true });
      },
      async delete() { data.delete(path); },
      collection(segment) { return collection(path + '/' + segment); },
      onSnapshot(listener) {
        const a = watchers.get(path) || [];
        a.push(listener); watchers.set(path, a);
        void this.get().then(listener);
        return () => { watchers.set(path, (watchers.get(path) || []).filter(x => x !== listener)); };
      },
    };
  }
  function collection(path) { return { doc(id) { return doc(path + '/' + id); } }; }
  return {
    data, collection,
    async runTransaction(fn) {
      return fn({ get: d => d.get(), create: (d, v) => d.set(v),
        update: (d, v) => d.update(v), set: (d, v, opts) => d.set(v, opts) });
    },
  };
}

function makeService({ lock = null } = {}) {
  const db = memoryDb(), events = [];
  const liveLock = lock === null
    ? { consumerId: 'consumer-1', expiresAt: Date.now() + 60000 }
    : lock;
  const service = new ExecutionService({
    db, ownerId: 'owner',
    startConsumer: async () => ({ state: 'attached', consumerId: 'consumer-1' }),
    getLock: async () => ({ lock: liveLock }),
    backend: () => ({ append: async e => { events.push(e); } }),
  });
  return { db, events, service };
}

async function setup(ctx) {
  await ctx.db.collection('users').doc('owner').collection('projects').doc('project-1').set({ name: 'Repo' });
  return ctx.service.create('owner', { project_id: 'project-1' });
}

test('command gets durable execution ID before consumer completion, keyed retry executes once', async () => {
  const ctx = makeService(), ws = await setup(ctx);
  const args = { workspace_id: ws.workspace_id, command: 'echo hello',
    idempotency_key: 'test-key-123', yield_time_ms: 0 };
  const first = await ctx.service.invoke('owner', 'run_command', args);
  assert.match(first.execution_id, /^[a-f0-9]{32}$/);
  assert.ok(first.execution_id.startsWith(ws.workspace_id.slice(0, 24)));
  assert.ok(first.execution_id.endsWith('00000001'));
  assert.equal(first.state, 'queued');
  assert.equal(ctx.events.length, 1);
  const same = await ctx.service.invoke('owner', 'run_command', args);
  assert.equal(same.execution_id, first.execution_id);
  assert.equal(ctx.events.length, 1);
  await assert.rejects(ctx.service.invoke('owner', 'run_command', {
    ...args, command: 'rm -rf important',
  }), /Idempotency key conflicts/);
  assert.equal(ctx.events.length, 1);
  assert.equal(ctx.events[0].data.mcp.execution_id, first.execution_id);
});

test('claim fences stale consumers and persists ordered output before completion', async () => {
  const ctx = makeService(), ws = await setup(ctx);
  const created = await ctx.service.invoke('owner', 'run_command', {
    workspace_id: ws.workspace_id, command: 'printf hello; exit 7', yield_time_ms: 0,
  });
  assert.deepEqual(await ctx.service.claim('owner', 'project-1', ws.workspace_id, 1, 'stale'), {
    ok: false, claimed: false,
  });
  assert.deepEqual(await ctx.service.claim('owner', 'project-1', ws.workspace_id, 1, 'consumer-1'), {
    ok: true, claimed: true,
  });
  assert.deepEqual(await ctx.service.claim('owner', 'project-1', ws.workspace_id, 1, 'consumer-1'), {
    ok: false, claimed: false,
  });
  const packet = { execution_id: created.execution_id,
    chunk: { cursor: 1, stream: 'stdout', text: 'hello' } };
  assert.deepEqual(await ctx.service.progress('owner', 'project-1', ws.workspace_id, 1, packet), {
    ok: true,
  });
  assert.deepEqual(await ctx.service.progress('owner', 'project-1', ws.workspace_id, 1, packet), {
    ok: true, duplicate: true,
  });
  const chunk = await ctx.service.invoke('owner', 'command_output', {
    workspace_id: ws.workspace_id, execution_id: created.execution_id, cursor: 0,
  });
  assert.equal(chunk.stdout, 'hello');
  assert.equal(chunk.cursor, 1);
  assert.equal(chunk.state, 'running');
  assert.equal(chunk.timings_ms.total, null);
  assert.ok(chunk.timings_ms.elapsed >= 0);
  const result = await ctx.service.complete('owner', 'project-1', ws.workspace_id, 1, {
    execution_id: created.execution_id, state: 'completed', exit_code: 7,
    cursor: 1, error: null,
  });
  assert.equal(result.ok, true);
  const done = await ctx.service.invoke('owner', 'command_output', {
    workspace_id: ws.workspace_id, execution_id: created.execution_id, cursor: 1,
  });
  assert.equal(done.state, 'completed');
  assert.equal(done.exit_code, 7);
  assert.equal(done.stderr, '');
  assert.equal(done.error, null);
  assert.ok(done.timings_ms.submission >= 0);
  assert.ok(done.timings_ms.delivery >= 0);
  assert.ok(done.timings_ms.execution >= 0);
  assert.ok(done.timings_ms.total >= done.timings_ms.execution);
});

test('queued commands report waiting_for_consumer without a live lock', async () => {
  const ctx = makeService({ lock: undefined }), ws = await setup(ctx);
  // Explicitly override the lock getter to emulate a consumer crash.
  ctx.service.getLock = async () => ({ lock: null });
  const result = await ctx.service.invoke('owner', 'run_command', {
    workspace_id: ws.workspace_id, command: 'echo later', yield_time_ms: 0,
  });
  assert.equal(result.state, 'waiting_for_consumer');
  assert.equal(ctx.events.length, 1);
});

test('readiness is not inferred from an active GKE Job without heartbeat', async () => {
  const ctx = makeService();
  const ws = await setup(ctx);
  const acquiredAt = Date.now() - 5000;
  ctx.service.inspectJob = async () => ({ state: 'active', active: 1 });
  ctx.service.getLock = async () => ({ lock: {
    consumerId: 'consumer-1', expiresAt: Date.now() + 60000, acquiredAt,
    runtime: { mode: 'gke', namespace: 'awfl', consumerJobName: 'consumer-1' },
  } });
  let status = await ctx.service.status('owner', { projectId: 'project-1' });
  assert.equal(status.state, 'starting');
  assert.equal(status.consumer.readiness, 'initializing');
  ctx.service.getLock = async () => ({ lock: {
    consumerId: 'consumer-1', expiresAt: Date.now() + 60000, acquiredAt,
    runtime: { mode: 'gke', namespace: 'awfl', consumerJobName: 'consumer-1' },
    heartbeat: { at: Date.now(), acquiredAt, generation: acquiredAt,
      consumerId: 'consumer-1', connected: true, capacity: 4 },
  } });
  status = await ctx.service.status('owner', { projectId: 'project-1' });
  assert.equal(status.state, 'attached');
  assert.equal(status.consumer.connected, true);
});


test('consumer crash during a claimed command reports execution_lost without re-execution', async () => {
  const ctx = makeService(), ws = await setup(ctx);
  const started = await ctx.service.invoke('owner', 'run_command', {
    workspace_id: ws.workspace_id, command: 'deploy --once', yield_time_ms: 0,
  });
  assert.equal((await ctx.service.claim('owner', 'project-1', ws.workspace_id, 1, 'consumer-1')).claimed, true);
  ctx.service.getLock = async () => ({ lock: null });
  const done = await ctx.service.invoke('owner', 'command_output', {
    workspace_id: ws.workspace_id, execution_id: started.execution_id,
  });
  assert.equal(done.state, 'failed');
  assert.equal(done.error.code, 'execution_lost');
  assert.equal(ctx.events.length, 1);
});

test('startup timeout yields terminal consumer_start_timeout instead of waiting indefinitely', async () => {
  const ctx = makeService(), ws = await setup(ctx);
  const started = await ctx.service.invoke('owner', 'run_command', {
    workspace_id: ws.workspace_id, command: 'echo hello', yield_time_ms: 0,
  });
  const record = ctx.db.collection('mcpWorkspaces').doc(ws.workspace_id)
    .collection('mcpRequests').doc('00000001');
  await record.update({ startupDeadlineAt: Date.now() - 1 });
  const output = await ctx.service.invoke('owner', 'command_output', {
    workspace_id: ws.workspace_id, execution_id: started.execution_id,
  });
  assert.equal(output.state, 'failed');
  assert.equal(output.error.code, 'consumer_start_timeout');
});

test('queued unclaimed work can be redelivered to replacement generation without duplication', async () => {
  const ctx = makeService(), ws = await setup(ctx);
  const started = await ctx.service.invoke('owner', 'run_command', {
    workspace_id: ws.workspace_id, command: 'echo safe', yield_time_ms: 0,
  });
  assert.equal(ctx.events.length, 1);
  ctx.service.getLock = async () => ({ lock: {
    consumerId: 'consumer-2', expiresAt: Date.now() + 60000,
  } });
  await ctx.service.invoke('owner', 'command_output', {
    workspace_id: ws.workspace_id, execution_id: started.execution_id,
  });
  assert.equal(ctx.events.length, 2);
  assert.equal(ctx.events[1].data.mcp.execution_id, started.execution_id);
  assert.equal((await ctx.service.claim('owner', 'project-1', ws.workspace_id, 1, 'consumer-2')).claimed, true);
  await ctx.service.invoke('owner', 'command_output', {
    workspace_id: ws.workspace_id, execution_id: started.execution_id,
  });
  assert.equal(ctx.events.length, 2);
});

test('old long execution IDs still parse with full workspace authorization', async () => {
  const { parseExecutionId } = await import('../service.js');
  const workspaceId = 'a'.repeat(32);
  assert.deepEqual(parseExecutionId('exec_' + workspaceId + '_00000002', workspaceId),
    { workspaceId, seq: 2 });
  assert.deepEqual(parseExecutionId(executionIdFor(workspaceId, 3), workspaceId),
    { workspaceId, seq: 3 });
  assert.throws(() => parseExecutionId(executionIdFor(workspaceId, 3), 'b'.repeat(32)),
    /Invalid execution ID/);
});


test('batched output commits 16 ordered cursors and preserves stdout/stderr', async () => {
  const ctx = makeService(), ws = await setup(ctx);
  const command = await ctx.service.invoke('owner', 'run_command', {
    workspace_id: ws.workspace_id, command: 'large stream', yield_time_ms: 0,
  });
  await ctx.service.claim('owner', 'project-1', ws.workspace_id, 1, 'consumer-1');
  const chunks = Array.from({ length: 16 }, (_, i) => ({
    cursor: i + 1, stream: i % 2 ? 'stderr' : 'stdout', text: 'chunk-' + i + '\n',
  }));
  const result = await ctx.service.progressBatch('owner', 'project-1', ws.workspace_id, 1,
    { execution_id: command.execution_id, chunks });
  assert.equal(result.ok, true);
  assert.equal(result.persisted, 16);
  assert.equal(result.cursor, 16);
  const replay = await ctx.service.progressBatch('owner', 'project-1', ws.workspace_id, 1,
    { execution_id: command.execution_id, chunks });
  assert.equal(replay.duplicate, true);
  const next = await ctx.service.invoke('owner', 'command_output', {
    workspace_id: ws.workspace_id, execution_id: command.execution_id,
    cursor: 0, max_bytes: 200000,
  });
  assert.equal(next.chunks.length, 16);
  assert.equal(next.cursor, 16);
  assert.equal(next.stdout, chunks.filter(x => x.stream === 'stdout').map(x => x.text).join(''));
  assert.equal(next.stderr, chunks.filter(x => x.stream === 'stderr').map(x => x.text).join(''));
});

test('partially retried batch appends only a new suffix without duplication', async () => {
  const ctx = makeService(), ws = await setup(ctx);
  const command = await ctx.service.invoke('owner', 'run_command', {
    workspace_id: ws.workspace_id, command: 'echo retry', yield_time_ms: 0,
  });
  await ctx.service.claim('owner', 'project-1', ws.workspace_id, 1, 'consumer-1');
  const chunks = Array.from({ length: 12 }, (_, i) => ({
    cursor: i + 1, stream: 'stdout', text: String(i),
  }));
  await ctx.service.progressBatch('owner', 'project-1', ws.workspace_id, 1,
    { execution_id: command.execution_id, chunks: chunks.slice(0, 5) });
  const result = await ctx.service.progressBatch('owner', 'project-1', ws.workspace_id, 1,
    { execution_id: command.execution_id, chunks });
  assert.equal(result.ok, true);
  assert.equal(result.persisted, 7);
  const output = await ctx.service.invoke('owner', 'command_output', {
    workspace_id: ws.workspace_id, execution_id: command.execution_id, max_bytes: 65536,
  });
  assert.equal(output.chunks.length, 12);
  assert.equal(output.stdout, '01234567891011');
});

test('batch validates cursor gaps, conflicts and payload size before mutations', async () => {
  const ctx = makeService(), ws = await setup(ctx);
  const command = await ctx.service.invoke('owner', 'run_command', {
    workspace_id: ws.workspace_id, command: 'check bounds', yield_time_ms: 0,
  });
  await ctx.service.claim('owner', 'project-1', ws.workspace_id, 1, 'consumer-1');
  const attrs = { execution_id: command.execution_id };
  const call = chunks => ctx.service.progressBatch(
    'owner', 'project-1', ws.workspace_id, 1, { ...attrs, chunks });
  assert.equal((await call([{ cursor: 2, stream: 'stdout', text: 'gap' }])).ok, false);
  await assert.rejects(call([{ cursor: 1, stream: 'stdout', text: 'x'.repeat(131073) }]), /128KiB/);
  await assert.rejects(call([
    { cursor: 1, stream: 'stdout', text: 'first' },
    { cursor: 3, stream: 'stdout', text: 'not contiguous' },
  ]), /contiguous/);
  const record = ctx.db.collection('mcpWorkspaces').doc(ws.workspace_id)
    .collection('mcpRequests').doc('00000001');
  assert.equal((await record.get()).data().outputCursor, 0);
  await call([{ cursor: 1, stream: 'stdout', text: 'correct' }]);
  const conflict = await call([{ cursor: 1, stream: 'stderr', text: 'wrong' }]);
  assert.equal(conflict.ok, false);
  assert.match(conflict.error, /conflict/);
  const recordAfter = await record.get();
  assert.equal(recordAfter.data().outputCursor, 1);
});

test('mixed legacy single-chunk and batched output writes remain cursor compatible', async () => {
  const ctx = makeService(), ws = await setup(ctx);
  const cmd = await ctx.service.invoke('owner', 'run_command', {
    workspace_id: ws.workspace_id, command: 'mixed', yield_time_ms: 0,
  });
  await ctx.service.claim('owner', 'project-1', ws.workspace_id, 1, 'consumer-1');
  assert.equal((await ctx.service.progress('owner', 'project-1', ws.workspace_id, 1, {
    execution_id: cmd.execution_id, chunk: { cursor: 1, stream: 'stdout', text: 'one' },
  })).ok, true);
  const progress = await ctx.service.progressBatch('owner', 'project-1', ws.workspace_id, 1, {
    execution_id: cmd.execution_id,
    chunks: [
      { cursor: 2, stream: 'stderr', text: 'two' },
      { cursor: 3, stream: 'stdout', text: 'three' },
    ],
  });
  assert.equal(progress.cursor, 3);
  const result = await ctx.service.invoke('owner', 'command_output', {
    workspace_id: ws.workspace_id, execution_id: cmd.execution_id,
  });
  assert.equal(result.stdout, 'onethree');
  assert.equal(result.stderr, 'two');
});
