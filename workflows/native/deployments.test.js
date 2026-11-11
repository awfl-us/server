import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeDeploymentService } from './deployments.js';

const SHA = 'a'.repeat(64);

function fixture() {
  const records = new Map();
  const writes = [];
  const approvals = [];
  const db = {
    collection: collection => {
      assert.equal(collection, 'nativeDeployments');
      return {
        doc: name => ({
          set: async record => { writes.push(['set', name]); records.set(name, record); },
          delete: async () => { writes.push(['delete', name]); records.delete(name); },
          get: async () => ({
            exists: records.has(name),
            data: () => records.get(name),
          }),
        }),
      };
    },
  };
  let enabled = true;
  const registry = {
    resolve: async ({ sha256, protocolVersion }) => {
      approvals.push({ sha256, protocolVersion });
      if (!enabled || sha256 !== SHA || protocolVersion !== 2) {
        throw new Error('artifact not signed by trusted CI');
      }
      return {
        sha256, protocolVersion, publisherKeyId: 'ci',
        allowedOperations: Object.freeze(['http.post']),
      };
    },
  };
  const service = new NativeDeploymentService({
    db, registry, siteOwnerUid: 'site-owner', clock: () => 12345,
  });
  return {
    records, writes, approvals, service,
    revoke: () => { enabled = false; },
  };
}

test('site owner alone may activate a signed Rust artifact for all users', async () => {
  const f = fixture();
  const deployed = await f.service.deploy({
    authenticatedUserId: 'site-owner',
    workflowName: 'EventHandler',
    artifactSha256: SHA,
    protocolVersion: 2,
  });
  assert.deepEqual(deployed, {
    workflowName: 'EventHandler', schemaVersion: 1,
    artifactSha256: SHA, protocolVersion: 2,
    publisherKeyId: 'ci', allowedOperations: ['http.post'],
    deployedBy: 'site-owner', updatedAt: 12345,
  });
  assert.deepEqual(f.writes, [['set', 'EventHandler']]);
  assert.deepEqual(f.approvals, [{ sha256: SHA, protocolVersion: 2 }]);
  // Execution lookup intentionally does not require the site owner:
  // end users may execute approved workflows without deploying code.
  assert.deepEqual(await f.service.resolveActive({ workflowName: 'EventHandler' }), {
    workflowName: 'EventHandler', artifactSha256: SHA, protocolVersion: 2,
    allowedOperations: ['http.post'],
  });
});

test('ordinary users, project owners and spoofed request fields cannot deploy or undeploy', async () => {
  const f = fixture();
  for (const authenticatedUserId of [null, undefined, '', 'normal-user', 'project-owner']) {
    await assert.rejects(f.service.deploy({
      authenticatedUserId,
      workflowName: 'EventHandler', artifactSha256: SHA, protocolVersion: 2,
      userId: 'site-owner', projectId: 'site-owner', isOwner: true, role: 'admin',
    }), /site owner required/);
    await assert.rejects(f.service.undeploy({
      authenticatedUserId, workflowName: 'EventHandler',
      userId: 'site-owner', isOwner: true,
    }), /site owner required/);
  }
  assert.deepEqual(f.writes, [], 'no deployment writes may occur');
  assert.deepEqual(f.approvals, [], 'not even registry access for denied callers');
});

test('deployment fails closed without explicit site-owner configuration', () => {
  const f = fixture();
  const db = f.service.db;
  const registry = f.service.registry;
  for (const siteOwnerUid of [null, '', '  ', undefined]) {
    // An absent environment setting must not trigger the MCP API-key
    // fallback or treat a project owner as the site owner.
    if (siteOwnerUid === undefined) {
      const previous = process.env.MCP_OWNER_UID;
      delete process.env.MCP_OWNER_UID;
      try {
        assert.throws(() => new NativeDeploymentService({
          db, registry,
        }), /site owner UID must be explicitly configured/);
      } finally {
        if (previous !== undefined) process.env.MCP_OWNER_UID = previous;
      }
    } else {
      assert.throws(() => new NativeDeploymentService({
        db, registry, siteOwnerUid,
      }), /site owner UID must be explicitly configured/);
    }
  }
});

test('site owner cannot deploy unsigned, mismatched or unapproved artifact inputs', async () => {
  const f = fixture();
  for (const [workflowName, artifactSha256, protocolVersion] of [
    ['../escape', SHA, 2],
    ['EventHandler', 'bogus', 2],
    ['EventHandler', SHA, 3],
    ['EventHandler', SHA, 1],
    ['', SHA, 2],
  ]) {
    await assert.rejects(f.service.deploy({
      authenticatedUserId: 'site-owner',
      workflowName, artifactSha256, protocolVersion,
    }));
  }
  assert.deepEqual(f.writes, []);
  f.revoke();
  await assert.rejects(f.service.deploy({
    authenticatedUserId: 'site-owner',
    workflowName: 'EventHandler', artifactSha256: SHA, protocolVersion: 2,
  }), /not signed by trusted CI/);
  assert.deepEqual(f.writes, []);
});

test('only the site owner can withdraw a deployment; revoked approval blocks execution', async () => {
  const f = fixture();
  await f.service.deploy({
    authenticatedUserId: 'site-owner',
    workflowName: 'EventHandler',
    artifactSha256: SHA, protocolVersion: 2,
  });
  f.revoke();
  await assert.rejects(f.service.resolveActive({
    workflowName: 'EventHandler',
  }), /not signed by trusted CI/);
  await assert.rejects(f.service.undeploy({
    authenticatedUserId: 'normal-user',
    workflowName: 'EventHandler',
  }), /site owner required/);
  assert.equal(f.records.has('EventHandler'), true);
  assert.deepEqual(await f.service.undeploy({
    authenticatedUserId: 'site-owner',
    workflowName: 'EventHandler',
  }), { workflowName: 'EventHandler', undeployed: true });
  assert.equal(await f.service.resolveActive({
    workflowName: 'EventHandler',
  }), null);
  assert.deepEqual(f.writes, [
    ['set', 'EventHandler'], ['delete', 'EventHandler'],
  ]);
});

test('active deployment rejects approval capability or publisher changes', async () => {
  const f = fixture();
  await f.service.deploy({
    authenticatedUserId: 'site-owner', workflowName: 'EventHandler',
    artifactSha256: SHA, protocolVersion: 2,
  });
  const record = f.records.get('EventHandler');
  f.records.set('EventHandler', { ...record, allowedOperations: ['http.patch'] });
  await assert.rejects(f.service.resolveActive({
    workflowName: 'EventHandler',
  }), /approval changed/);
  f.records.set('EventHandler', { ...record, publisherKeyId: 'untrusted' });
  await assert.rejects(f.service.resolveActive({
    workflowName: 'EventHandler',
  }), /approval changed/);
  f.records.set('EventHandler', { ...record, deployedBy: 'normal-user' });
  await assert.rejects(f.service.resolveActive({
    workflowName: 'EventHandler',
  }), /invalid active native deployment/);
});
