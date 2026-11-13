import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeCallbackEffects, nativeCallbackIdFromUrl } from './callbackEffects.js';
import { createNativeLocalRunner } from './localWorkflows.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const origin = 'https://jobs.example.org';
const identity = { userId: 'native-user', projectId: 'native-project' };
const execId = 'native_' + 'c'.repeat(32);

function firestore() {
  const records = new Map(), watchers = new Map();
  const snapshot = path => ({ exists: records.has(path), data: () => records.get(path) });
  const doc = path => ({
    path,
    get: async () => snapshot(path),
    onSnapshot(fn) {
      const set = watchers.get(path) || new Set();
      set.add(fn);
      watchers.set(path, set);
      queueMicrotask(() => fn(snapshot(path)));
      return () => set.delete(fn);
    },
  });
  return {
    records, doc,
    runTransaction: fn => fn({
      get: async ref => snapshot(ref.path),
      create: (ref, value) => records.set(ref.path, value),
    }),
    deliver(path, body) {
      const value = records.get(path);
      assert.ok(value, 'callback record must exist');
      records.set(path, { ...value, called_at: Date.now(),
        native_result_json: JSON.stringify(body) });
      for (const fn of watchers.get(path) || []) fn(snapshot(path));
    },
  };
}

test('real generated CliTools Rust binary creates and consumes an AWFL callback record',
  { skip: !process.env.AWFL_NATIVE_TEST_TOOLS_BINARY }, async () => {
    const path = process.env.AWFL_NATIVE_TEST_TOOLS_BINARY;
    const bytes = await readFile(path);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const db = firestore();
    const callbackHandlers = createNativeCallbackEffects({ db, jobsOrigin: origin });
    const calls = [];
    let delivered = false;
    const handlers = {
      ...callbackHandlers,
      'log.write': async () => null,
      'http.post': async ({ args, identity: checkedIdentity }) => {
        assert.deepEqual(checkedIdentity, identity);
        const url = new URL(args.url);
        calls.push(url.pathname);
        if (url.pathname === '/callbacks') {
          const id = nativeCallbackIdFromUrl(args.body.callback_url, origin);
          assert.ok(id);
          const doc = db.records.get('users/native-user/callbacks/' + id);
          assert.equal(doc.native_project_id, identity.projectId);
          return { code: 201, body: { id, callback_url: args.body.callback_url } };
        }
        if (url.pathname === '/producer/start') {
          // This simulates only delivery, not the native Rust continuation.
          // A real workflow.run/shell action is tested separately in Jobs.
          if (!delivered) {
            delivered = true;
            const [path] = [...db.records.keys()];
            queueMicrotask(() => db.deliver(path, {
              status: 'ok', output: 'native callback completed',
            }));
          }
          return { code: 200, body: { accepted: true } };
        }
        if (url.pathname === '/firebase/create' ||
            url.pathname === '/firebase/update' ||
            url.pathname === '/events') {
          return { code: 200, body: { ok: true } };
        }
        throw new Error('Unexpected Jobs path: ' + url.pathname);
      },
    };
    const releases = { active: async () => null, materialize: async () => null };
    const runner = createNativeLocalRunner({
      releases, handlers, rootExecutionId: execId, identity,
      gcpProject: 'awfl-us', region: 'us-central1',
      onProgress: progress => console.log('PROGRESS', JSON.stringify(progress)),
    });
    const input = {
      tool_call: { id: 'test', type: 'function',
        function: { name: 'RUN_COMMAND', arguments: '{"command":"pwd"}' } },
      cost: 0, timeoutSeconds: 60,
      env: { ...identity, sessionId: 'test-session', model: 'gpt-5',
        callingWorkflowExec: '', BASE_URL: origin, background: false,
        workdir: '/workspace' },
    };
    const globals = {
      GOOGLE_CLOUD_WORKFLOW_ID: 'tools-CliTools',
      GOOGLE_CLOUD_WORKFLOW_EXECUTION_ID: execId,
      GOOGLE_CLOUD_PROJECT_ID: 'awfl-us',
      GOOGLE_CLOUD_LOCATION: 'us-central1',
    };
    try {
      const result = await runner.run({
        workflowName: 'tools-CliTools',
        release: { sha256: sha, protocolVersion: 2,
          allowedOperations: ['http.post','log.write','callback.create','callback.await'] },
        artifact: { sha256: sha, executable: path }, input, globals, executionId: execId,
      });
      assert.equal(delivered, true);
      assert.ok(result);
      assert.ok(calls.includes('/callbacks'));
      assert.ok(calls.includes('/producer/start'));
      assert.equal(db.records.size, 1);
    } catch (error) {
      console.error('FAILED_NATIVE_ERROR', JSON.stringify(error.nativeError || error.message));
      console.error('HTTP_CALLS', JSON.stringify(calls));
      console.error('CALLBACK_RECORDS', JSON.stringify([...db.records.entries()]));
      throw error;
    } finally {
      await runner.close();
    }
  });
