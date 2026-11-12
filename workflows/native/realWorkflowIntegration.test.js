// End-to-end native worker smoke for the *unchanged* LoadConversationHistory
// Scala workflow. The compiler builds its Rust artifact from the workflows
// repository; this test runs that ELF through the actual native Jobs worker,
// durable checkpoint/effect journal and result replay. HTTP is mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { NativeExecutionStore } from './executionStore.js';
import { runNativeWorkflow } from './worker.js';

const executable = process.env.AWFL_NATIVE_REAL_WORKFLOW_BINARY;
const required = process.env.AWFL_NATIVE_REAL_WORKFLOW_REQUIRED === '1';
if (required && !executable) {
  throw new Error('real workflow integration requires compiled LoadConversationHistory artifact');
}

function memoryFirestore() {
  const docs = new Map();
  return {
    collection: name => ({ doc: key => ({
      key: `${name}/${key}`,
      async get() {
        const data = docs.get(this.key);
        return { exists: data !== undefined, data: () => structuredClone(data) };
      },
    }) }),
    async runTransaction(fn) {
      const writes = [];
      const tx = {
        get: ref => ref.get(),
        create: (ref, data) => writes.push([ref.key, structuredClone(data)]),
        update: (ref, data) => writes.push([ref.key, structuredClone(data)]),
      };
      const result = await fn(tx);
      for (const [key, data] of writes) docs.set(key, data);
      return result;
    },
  };
}

test('unchanged production LoadConversationHistory compiles, journals HTTP and replays through Jobs worker',
  { skip: !executable, timeout: 60_000 }, async () => {
    const bytes = await readFile(executable);
    const artifactSha256 = createHash('sha256').update(bytes).digest('hex');
    const store = new NativeExecutionStore({ db: memoryFirestore() });
    const executionId = 'native_' + 'b'.repeat(32);
    const userId = 'production-test-owner', projectId = 'production-test-project';
    // The authenticated Workflows service supplies env, not the remote caller.
    const input = { arg1: 'conversation-042', arg2: 'customer-17',
      env: { BASE_URL: 'https://example.invalid', userId, projectId } };
    await store.create({ executionId, userId, projectId,
      workflowName: 'LoadConversationHistory',
      protocolVersion: 2, artifactSha256, input,
      allowedOperations: ['http.post'] });

    let dispatched = 0;
    const handlers = { 'http.post': async ({ args, identity, idempotencyKey }) => {
      dispatched++;
      assert.equal(identity.userId, userId);
      assert.equal(identity.projectId, projectId);
      assert.equal(idempotencyKey.startsWith(`${executionId}:`), true);
      assert.equal(args.url,
        'https://example.invalid/convo-history/loadConvoHistory');
      assert.deepEqual(args.body,
        { objectName: 'conversation-042', userId: 'customer-17' });
      assert.deepEqual(args.headers,
        { 'x-user-id': userId, 'x-project-id': projectId });
      assert.deepEqual(args.auth,
        { type: 'OIDC', audience: 'https://example.invalid' });
      return { body: null, status: 200 };
    } };
    const releases = { materialize: async pinned => {
      assert.equal(pinned, artifactSha256);
      return { executable, sha256: artifactSha256, cleanup: async () => {} };
    } };
    const run = () => runNativeWorkflow({ store, releases,
      executionId, userId, projectId, handlers });

    assert.deepEqual(await run(), { status: 'success' });
    assert.equal(dispatched, 1);
    const persisted = await store.get(executionId);
    assert.equal(persisted.status, 'completed');
    assert.equal(persisted.effectCount, 1);
    assert.deepEqual(persisted.result, { status: 'success' });
    assert.deepEqual(await run(), { status: 'success' });
    assert.equal(dispatched, 1, 're-delivery must never re-dispatch the HTTP effect');
  });
