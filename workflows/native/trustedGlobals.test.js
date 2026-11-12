import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNativeTrustedGlobals, executeNativeStep } from './runner.js';

const executionId = 'native_' + 'a'.repeat(32);
const expectedGlobals = {
  GOOGLE_CLOUD_WORKFLOW_ID: 'TestWorkflow',
  GOOGLE_CLOUD_WORKFLOW_EXECUTION_ID: executionId,
  GOOGLE_CLOUD_PROJECT_ID: 'trusted-gcp-project',
  GOOGLE_CLOUD_LOCATION: 'us-central1',
};

test('server derives globals from persisted execution and Google deployment, never tenant input', () => {
  const state = {
    executionId, workflowName: 'TestWorkflow', projectId: 'tenant-project',
    input: { env: { GOOGLE_CLOUD_PROJECT_ID: 'spoofed' } },
  };
  assert.deepEqual(buildNativeTrustedGlobals({
    state, executionId, gcpProject: 'trusted-gcp-project', region: 'us-central1',
  }), expectedGlobals);
  assert.throws(() => buildNativeTrustedGlobals({
    state, executionId: 'native_' + 'b'.repeat(32),
    gcpProject: 'trusted-gcp-project', region: 'us-central1',
  }), /identity mismatch/);
  assert.equal(buildNativeTrustedGlobals({
    state: { ...state, workflowName: null }, executionId,
    gcpProject: 'trusted-gcp-project', region: 'us-central1',
  }), null);
});

test('trusted native worker passes separate globals through real verified subprocess', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awfl-trusted-globals-'));
  try {
    const executable = join(root, 'test-artifact');
    const contents = [
      '#!/usr/bin/env node',
      'let text = "";',
      'process.stdin.on("data", chunk => { text += chunk; });',
      'process.stdin.on("end", () => {',
      ' const request = JSON.parse(text);',
      ' process.stdout.write(JSON.stringify({ protocol_version: 2, status: "completed", result: request }));',
      '});',
      '',
    ].join('\n');
    await writeFile(executable, contents);
    await chmod(executable, 0o700);
    const sha256 = createHash('sha256').update(contents).digest('hex');
    const callerInput = { env: {
      GOOGLE_CLOUD_WORKFLOW_ID: 'spoofed',
      GOOGLE_CLOUD_WORKFLOW_EXECUTION_ID: 'spoofed',
      GOOGLE_CLOUD_PROJECT_ID: 'tenant-project',
      GOOGLE_CLOUD_LOCATION: 'wrong-location',
    } };
    const state = {
      executionId, workflowName: 'TestWorkflow',
      userId: 'owner', projectId: 'tenant-project',
      protocolVersion: 2, trustedGlobalsVersion: 1, epoch: 9, artifactSha256: sha256,
      input: callerInput, checkpoint: null, pendingEffect: null,
    };
    let persisted;
    const store = {
      claim: async () => state,
      complete: async record => { persisted = record; },
    };
    const result = await executeNativeStep({
      store, executionId, workerId: 'native_test_worker',
      executable, sha256,
      gcpProject: 'trusted-gcp-project', region: 'us-central1',
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.result.trusted_globals, expectedGlobals);
    assert.deepEqual(result.result.input, callerInput);
    assert.equal(result.result.protocol_version, 2);
    assert.equal(persisted.epoch, 9);
    assert.deepEqual(persisted.result, result.result);
    // The same ABI 3/protocol v2 but older release does not declare the
    // capability. Old binaries' deny_unknown_fields Request must still work.
    const legacyState = { ...state, trustedGlobalsVersion: undefined };
    const legacyStore = {
      claim: async () => legacyState,
      complete: async () => {},
    };
    const legacy = await executeNativeStep({
      store: legacyStore, executionId, workerId: 'legacy_worker',
      executable, sha256,
      gcpProject: 'trusted-gcp-project', region: 'us-central1',
    });
    assert.equal(legacy.status, 'completed');
    assert.equal(Object.hasOwn(legacy.result, 'trusted_globals'), false);
    assert.deepEqual(legacy.result.input, callerInput);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
