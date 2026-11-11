// Real Firestore emulator test: site-scoped native release alias.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createRequire } from 'node:module';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeArtifactRegistry } from './artifactRegistry.js';
import { NativeDeploymentService } from './deployments.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
let db;
if (enabled) {
  if (process.env.AWFL_FIRESTORE_CLIENT_ROOT) {
    const require = createRequire(process.env.AWFL_FIRESTORE_CLIENT_ROOT + '/package.json');
    const { Firestore } = require('@google-cloud/firestore');
    db = new Firestore({ projectId: 'demo-awfl-native' });
  } else {
    const { initializeApp } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');
    db = getFirestore(initializeApp({ projectId: 'demo-awfl-native' }, 'native-deploy-tests'));
  }
}
after(async () => { if (db) await db.terminate(); });

test('emulator: only site owner activates signed artifact; ordinary user may resolve execution', {
  skip: !enabled, timeout: 45_000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'awfl-native-release-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const binary = Buffer.from('#!/bin/sh\nexit 0\n');
  const sha256 = createHash('sha256').update(binary).digest('hex');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const manifest = {
    schemaVersion: 1, publisherKeyId: 'trusted-ci',
    artifactSha256: sha256, protocolVersion: 2,
    runtimeAbi: 3, allowedOperations: ['http.post'],
  };
  const signature = sign(null, Buffer.from(JSON.stringify(manifest)), privateKey).toString('base64');
  await writeFile(join(directory, sha256 + '.bin'), binary);
  await writeFile(join(directory, sha256 + '.approval.json'),
    JSON.stringify({ manifest, signature }));
  const registry = new NativeArtifactRegistry({
    directory, trustedPublishers: { 'trusted-ci': publicKey },
    allowScriptsForTests: true,
  });
  const service = new NativeDeploymentService({
    db, registry, siteOwnerUid: 'site-owner', clock: () => 12345,
  });
  const name = 'NativeReleaseTest' + process.pid + Date.now();
  const ref = db.collection('nativeDeployments').doc(name);
  t.after(async () => ref.delete());
  await assert.rejects(service.deploy({
    authenticatedUserId: 'project-owner', workflowName: name,
    artifactSha256: sha256, protocolVersion: 2,
  }), /site owner required/);
  assert.equal((await ref.get()).exists, false);
  await service.deploy({
    authenticatedUserId: 'site-owner', workflowName: name,
    artifactSha256: sha256, protocolVersion: 2,
  });
  const written = (await ref.get()).data();
  assert.equal(written.deployedBy, 'site-owner');
  assert.equal(written.artifactSha256, sha256);
  assert.equal(written.protocolVersion, 2);
  assert.deepEqual(await service.resolveActive({ workflowName: name }), {
    workflowName: name,
    artifactSha256: sha256,
    protocolVersion: 2,
    allowedOperations: ['http.post'],
  });
  await assert.rejects(service.undeploy({
    authenticatedUserId: 'normal-user', workflowName: name,
  }), /site owner required/);
  assert.equal((await ref.get()).exists, true);
  await service.undeploy({
    authenticatedUserId: 'site-owner', workflowName: name,
  });
  assert.equal((await ref.get()).exists, false);
});
