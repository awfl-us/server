import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createNativeLocalRunner } from './localWorkflows.js';

const sha = 'a'.repeat(64);
const childSha = 'b'.repeat(64);
const rootId = 'native_' + 'c'.repeat(32);
const identity = { userId: 'owner', projectId: 'tenant' };
const localArgs = (workflow_id, argument, more = {}) => ({ workflow_id, argument,
  project_id: 'awfl-us', location: 'us-central1',
  connector_params: { skip_polling: false }, ...more });
const suspend = (op, args, slot = 's0', extra = {}) => ({ protocol_version: 2,
  status: 'suspended', effect: { operation: op, args, effect_id: 'effect_0',
    result_slot: slot, node_id: '0.0', ...extra },
  continuation: { next_step: 1, slots: {}, frames: [] },
});

function fixture({ childOperations = [], childResult = 21, childExists = true } = {}) {
  const calls = { active: [], materialize: [], cleanup: 0, transitions: [], effects: [] };
  const root = { sha256: sha, allowedOperations: ['workflow.run'] };
  const artifact = { executable: '/test/root', sha256: sha };
  const releases = {
    async active(name) {
      calls.active.push(name);
      if (!childExists) return null;
      return { workflowName: name, sha256: childSha, protocolVersion: 2,
        allowedOperations: childOperations, trustedGlobalsVersion: 1 };
    },
    async materialize(digest) {
      calls.materialize.push(digest);
      return { executable: '/test/child', sha256: digest,
        cleanup: async () => { calls.cleanup++; } };
    },
  };
  const runArtifact = async ({ executable, input }) => {
    calls.transitions.push([executable, input]);
    if (executable === '/test/child') {
      if (!input.continuation) return { protocol_version: 2,
        status: 'completed', result: childResult };
      throw new Error('unexpected child continuation');
    }
    if (!input.continuation) {
      return suspend('workflow.run', localArgs('LocalChild', { value: 1 }));
    }
    return { protocol_version: 2, status: 'completed',
      result: input.continuation.slots.s0 };
  };
  const runner = createNativeLocalRunner({ releases, handlers: {},
    identity, rootExecutionId: rootId, runArtifact,
    gcpProject: 'awfl-us', region: 'us-central1' });
  return { calls, root, artifact, runner, releases };
}

test('local child result resumes parent with no Tasks/Firestore and shared owner', async () => {
  const { runner, calls, root, artifact } = fixture();
  const result = await runner.run({ workflowName: 'LocalParent', release: root,
    artifact, executionId: rootId, input: { value: 1 } });
  assert.deepEqual(result, { type: 'integer', value: 21 });
  assert.equal(runner.childCalls, 1);
  assert.deepEqual(calls.active, ['LocalChild']);
  assert.deepEqual(calls.materialize, [childSha]);
  assert.equal(calls.transitions.length, 3);
  assert.match(calls.transitions[1][1].trusted_globals.GOOGLE_CLOUD_WORKFLOW_EXECUTION_ID,
    /^native_[a-f0-9]{32}$/);
  await runner.close();
  assert.equal(calls.cleanup, 1);
});

test('many calls to the same child reuse one release and executable', async () => {
  const { runner, calls, root, artifact } = fixture();
  let parentStep = 0;
  let callsChild = 0;
  // 20 child calls within the same Jobs request; no per-child database write.
  const emit = async ({ executable, input }) => {
    if (executable === '/test/child') {
      callsChild++;
      return { protocol_version: 2, status: 'completed', result: 7 };
    }
    if (parentStep++ < 20) {
      return suspend('workflow.run', localArgs('LocalChild', { i: parentStep }));
    }
    return { protocol_version: 2, status: 'completed', result: callsChild };
  };
  const r = createNativeLocalRunner({
    releases: {
      active: async name => { calls.active.push(name); return {
        workflowName: name, sha256: childSha, protocolVersion: 2,
        allowedOperations: [] }; },
      materialize: async () => { calls.materialize.push(childSha); return {
        executable: '/test/child', sha256: childSha, cleanup: async () => { calls.cleanup++; },
      }; },
    }, handlers: {}, identity, rootExecutionId: rootId,
    gcpProject: 'awfl-us', region: 'us-central1', runArtifact: emit,
  });
  assert.equal(await r.run({ workflowName: 'LocalParent', release: root,
    artifact, executionId: rootId, input: {} }), 20);
  assert.equal(r.childCalls, 20);
  assert.equal(calls.active.length, 1);
  assert.equal(calls.materialize.length, 1);
  await r.close();
  assert.equal(calls.cleanup, 1);
});

test('rejects missing unpublished child, detached calls, and caller-selected GCP project', async () => {
  const bad = [
    localArgs('LocalChild', {}, { connector_params: { skip_polling: true } }),
    localArgs('LocalChild', {}, { project_id: 'other-project' }),
    localArgs('../untrusted', {}),
  ];
  for (const args of bad) {
    const f = fixture();
    const runner = createNativeLocalRunner({ releases: f.releases,
      handlers: {}, identity, rootExecutionId: rootId,
      gcpProject: 'awfl-us', region: 'us-central1',
      runArtifact: async ({ executable, input }) => executable === '/test/root'
        ? (!input.continuation ? suspend('workflow.run', args) :
          { protocol_version: 2, status: 'completed', result: true })
        : { protocol_version: 2, status: 'completed', result: 1 },
    });
    await assert.rejects(runner.run({ workflowName: 'LocalParent',
      release: f.root, artifact: f.artifact, executionId: rootId, input: {} }),
    /unauthorized local workflow.run arguments/);
    assert.equal(f.calls.active.length, 0);
    await runner.close();
  }
  const f = fixture({ childExists: false });
  await assert.rejects(f.runner.run({ workflowName: 'LocalParent',
    release: f.root, artifact: f.artifact, executionId: rootId, input: {} }),
  /published native release/);
  await f.runner.close();
});

test('child effect is authorized by child manifest, not parent operation list', async () => {
  const f = fixture({ childOperations: [] });
  const runner = createNativeLocalRunner({ releases: f.releases,
    handlers: { 'http.post': async () => { throw Error('should not run'); } },
    identity, rootExecutionId: rootId, gcpProject: 'awfl-us',
    runArtifact: async ({ executable, input }) => executable === '/test/child'
      ? suspend('http.post', { url: 'https://example.org' })
      : (!input.continuation ? suspend('workflow.run', localArgs('LocalChild', {}))
        : { protocol_version: 2, status: 'completed', result: 1 }),
  });
  await assert.rejects(runner.run({ workflowName: 'LocalParent',
    release: f.root, artifact: f.artifact, executionId: rootId, input: {} }),
  /operation not allowed/);
  await runner.close();
});

test('compiled Try edge receives child workflow failure without losing parent continuation', async () => {
  const f = fixture({ childOperations: [] });
  let rootTransitions = 0;
  const runner = createNativeLocalRunner({ releases: f.releases,
    handlers: {}, identity, rootExecutionId: rootId,
    gcpProject: 'awfl-us', region: 'us-central1',
    runArtifact: async ({ executable, input }) => {
      if (executable === '/test/child') return { protocol_version: 2,
        status: 'failed', error: { message: 'child failure', code: null } };
      if (rootTransitions++ === 0) return suspend('workflow.run',
        localArgs('LocalChild', {}), 's0',
        { on_error: { next_step: 2, error_slot: 's1' } });
      assert.equal(input.continuation.next_step, 2);
      assert.equal(input.continuation.slots.s1.value.message.value, 'child failure');
      return { protocol_version: 2, status: 'completed', result: 'caught' };
    },
  });
  try {
    assert.equal(await runner.run({ workflowName: 'LocalParent',
      release: f.root, artifact: f.artifact, executionId: rootId, input: {} }), 'caught');
    assert.equal(runner.effectCount, 1);
  } finally { await runner.close(); }
});

test('recursive local workflow.run is bounded by depth and cannot schedule indefinitely', async () => {
  const calls = { manifests: 0 };
  const runner = createNativeLocalRunner({
    releases: {
      active: async name => { calls.manifests++; return {
        workflowName: name, sha256: childSha, protocolVersion: 2,
        allowedOperations: ['workflow.run'] }; },
      materialize: async () => ({ executable: '/test/self', sha256: childSha,
        cleanup: async () => {} }),
    }, handlers: {}, identity, rootExecutionId: rootId,
    gcpProject: 'awfl-us', region: 'us-central1',
    runArtifact: async () => suspend('workflow.run', localArgs('Self', {})),
  });
  try {
    await assert.rejects(runner.run({ workflowName: 'Self',
      release: { sha256: childSha, allowedOperations: ['workflow.run'] },
      artifact: { executable: '/test/self', sha256: childSha },
      executionId: rootId, input: {} }), /depth limit|call limit/);
    assert.equal(calls.manifests, 1, 'only one pinned release is loaded');
  } finally { await runner.close(); }
});

const realParent = process.env.AWFL_NATIVE_LOCAL_PARENT_BINARY;
const realChild = process.env.AWFL_NATIVE_LOCAL_CHILD_BINARY;
const realLeaf = process.env.AWFL_NATIVE_LOCAL_LEAF_BINARY;
const realHttpParent = process.env.AWFL_NATIVE_LOCAL_HTTP_PARENT_BINARY;
const realHttpChild = process.env.AWFL_NATIVE_LOCAL_HTTP_CHILD_BINARY;

test('real Scala-compiled parent invokes 20 nested child->leaf Rust calls locally', {
  skip: !(realParent && realChild && realLeaf), timeout: 90_000,
}, async () => {
  const bins = [
    ['LocalParent', realParent, ['workflow.run']],
    ['LocalChild', realChild, ['workflow.run']],
    ['LocalLeaf', realLeaf, []],
  ];
  const mapped = new Map();
  for (const [name, file, allowedOperations] of bins) {
    const sha256 = createHash('sha256').update(await readFile(file)).digest('hex');
    mapped.set(name, { sha256, file, allowedOperations });
  }
  let lookups = 0, materializations = 0, cleanup = 0;
  const releases = {
    active: async name => {
      lookups++;
      const found = mapped.get(name);
      return found && { workflowName: name, sha256: found.sha256,
        protocolVersion: 2, allowedOperations: found.allowedOperations,
        trustedGlobalsVersion: 1 };
    },
    materialize: async sha256 => {
      materializations++;
      const record = [...mapped.values()].find(x => x.sha256 === sha256);
      assert.ok(record);
      return { sha256, executable: record.file,
        cleanup: async () => { cleanup++; } };
    },
  };
  const runner = createNativeLocalRunner({
    releases, handlers: {}, rootExecutionId: rootId,
    identity, gcpProject: 'awfl-us', region: 'us-central1',
  });
  const root = mapped.get('LocalParent');
  try {
    const result = await runner.run({ workflowName: 'LocalParent',
      release: { sha256: root.sha256, allowedOperations: root.allowedOperations },
      artifact: { executable: root.file, sha256: root.sha256 },
      executionId: rootId, input: {},
    });
    assert.deepEqual(result, Array.from({ length: 20 }, (_, i) => i + 3));
    assert.equal(runner.childCalls, 40);
    assert.equal(lookups, 2, 'child and leaf each resolved only once');
    assert.equal(materializations, 2, 'one staged ELF per distinct child');
    assert.equal(runner.effectCount, 40);
  } finally { await runner.close(); }
  assert.equal(cleanup, 2);
});

test('real Scala-compiled parent executes an HTTP effect inside a local child', {
  skip: !(realHttpParent && realHttpChild), timeout: 25_000,
}, async () => {
  const parentSha = createHash('sha256').update(await readFile(realHttpParent)).digest('hex');
  const childSha = createHash('sha256').update(await readFile(realHttpChild)).digest('hex');
  let requests = 0;
  const runner = createNativeLocalRunner({
    rootExecutionId: rootId, identity,
    releases: {
      active: async name => name === 'LocalHttpChild' ? {
        sha256: childSha, protocolVersion: 2,
        allowedOperations: ['http.post'], trustedGlobalsVersion: 1,
      } : null,
      materialize: async () => ({ sha256: childSha, executable: realHttpChild,
        cleanup: async () => {} }),
    },
    handlers: { 'http.post': async ({ args, identity: scoped }) => {
      assert.deepEqual(scoped, identity);
      assert.equal(args.url, 'https://example.org/local');
      requests++;
      return 'HTTP_EFFECT_OK';
    } },
    gcpProject: 'awfl-us', region: 'us-central1',
  });
  try {
    assert.equal(await runner.run({ workflowName: 'LocalHttpParent',
      release: { sha256: parentSha, allowedOperations: ['workflow.run'] },
      artifact: { executable: realHttpParent, sha256: parentSha },
      executionId: rootId, input: {},
    }), 'HTTP_EFFECT_OK');
    assert.equal(requests, 1);
  } finally { await runner.close(); }
});
