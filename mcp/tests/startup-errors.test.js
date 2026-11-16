import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceStartError, unexpectedToolError } from '../startupErrors.js';
import { ExecutionService } from '../service.js';

function source(message, statusCode) {
  const e = new Error(message);
  if (statusCode !== undefined) e.statusCode = statusCode;
  return e;
}

test('missing profile returns actionable usage instead of a generic service failure', () => {
  const e = workspaceStartError(source('imageProfile is required when starting a new consumer'));
  assert.equal(e.code, 'IMAGE_PROFILE_REQUIRED');
  assert.match(e.publicMessage, /workspace_create/);
  assert.match(e.publicMessage, /image_profiles_list/);
  assert.match(e.publicMessage, /Only omit image_profile when attaching/);
  assert.equal(e.retryable, false);
});

test('changing shared consumer image explains attachment versus intentional stop', () => {
  const e = workspaceStartError(source('This project already runs the browser image; stop it before choosing scala'));
  assert.equal(e.code, 'IMAGE_PROFILE_CONFLICT');
  assert.match(e.publicMessage, /browser/);
  assert.match(e.publicMessage, /scala/);
  assert.match(e.publicMessage, /interrupts other sessions/);
});

test('unpublished image and producer validation failures give specific next steps', () => {
  const image = workspaceStartError(source('The scala image is not published/configured (CONSUMER_SCALA_K8S_IMAGE)', 400));
  assert.equal(image.code, 'IMAGE_NOT_CONFIGURED');
  assert.match(image.publicMessage, /image_profiles_list/);
  const config = workspaceStartError(source('unrecognized server validation error', 400));
  assert.equal(config.code, 'CONSUMER_CONFIGURATION_REJECTED');
  assert.doesNotMatch(config.publicMessage, /unrecognized server validation error/);
});

test('producer and Kubernetes errors remain diagnostic without leaking internal responses', () => {
  const k8s = workspaceStartError(source('Failed to create consumer Kubernetes Job', 500),
    { imageProfile: 'scala' });
  assert.equal(k8s.code, 'KUBERNETES_JOB_START_FAILED');
  assert.equal(k8s.retryable, true);
  assert.match(k8s.publicMessage, /Requested image_profile=scala/);
  assert.match(k8s.publicMessage, /Diagnostic reference: [a-f0-9]{12}/);
  const raw = source('private header Authorization: Bearer super-secret', 500);
  const unknown = workspaceStartError(raw, { imageProfile: 'scala' });
  assert.equal(unknown.code, 'CONSUMER_START_FAILED');
  assert.doesNotMatch(unknown.publicMessage, /Authorization|super-secret/);
  assert.equal(unknown.cause, raw);
});

test('unexpected MCP errors preserve known public messages but hide raw exceptions', () => {
  const safe = workspaceStartError(source('imageProfile is required when starting a new consumer'));
  assert.equal(unexpectedToolError(safe, 'workspace_create'), safe.publicMessage);
  const unexpected = unexpectedToolError(source('token=super-secret'), 'read_file');
  assert.match(unexpected, /MCP_INTERNAL_ERROR/);
  assert.match(unexpected, /diagnostic reference [a-f0-9]{12}/);
  assert.doesNotMatch(unexpected, /super-secret/);
});

test('workspace startup failure does not allocate an MCP workspace', async () => {
  const data = new Map();
  const db = {
    collection(collection) {
      return {
        doc(id) {
          const path = collection + '/' + id;
          return {
            collection(child) { return db.collection(path + '/' + child); },
            async get() { return { exists: data.has(path), data: () => data.get(path) }; },
            async set(value) { data.set(path, value); },
          };
        },
      };
    },
  };
  const projectId = 'repo-1';
  data.set('users/owner/projects/' + projectId, { name: 'Repo' });
  const service = new ExecutionService({
    db, ownerId: 'owner',
    startConsumer: async () => { throw source('Transport error creating consumer K8s Job', 500); },
  });
  await assert.rejects(service.invoke('owner', 'workspace_create', {
    project_id: projectId, image_profile: 'scala',
  }), error => error.code === 'KUBERNETES_JOB_START_FAILED' && error.retryable === true);
  assert.equal([...data.keys()].filter(key => key.startsWith('mcpWorkspaces/')).length, 0);
});

test('control-plane guidance identifies the required image profile for fresh consumers', async () => {
  const service = new ExecutionService({ db: {}, ownerId: 'owner' });
  const status = await service.invoke('owner', 'environment_status', {});
  assert.equal(status.state, 'control_plane_ready');
  assert.match(status.next_step, /image_profiles_list/);
  assert.match(status.next_step, /image_profile: "scala"/);
  assert.match(status.next_step, /existing running consumer/);
});
