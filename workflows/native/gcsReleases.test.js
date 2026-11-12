import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { NativeGcsReleases } from './gcsReleases.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x00]);
const sha256 = hash(elf);
const metadata = {
  schemaVersion: 1, workflowName: 'Example',
  artifactSha256: sha256, protocolVersion: 2,
  runtimeAbi: 3, allowedOperations: ['http.post'],
};

function fixture({ manifest = metadata, binary = elf } = {}) {
  const objects = new Map([
    ['native-workflows/active/Example.json', Buffer.from(JSON.stringify(manifest))],
    ['native-workflows/artifacts/' + sha256 + '.bin', binary],
  ]);
  const reads = [];
  const storage = {
    bucket: name => {
      assert.equal(name, 'test-native-artifacts');
      return {
        file: path => {
          reads.push(path);
          return {
            getMetadata: async () => {
              const bytes = objects.get(path);
              if (!bytes) throw Object.assign(new Error('missing'), { code: 404 });
              return [{ size: bytes.length }];
            },
            createReadStream: () => Readable.from([objects.get(path)]),
          };
        },
      };
    },
  };
  return {
    objects, reads, releases: new NativeGcsReleases({
      storage, bucket: 'test-native-artifacts',
    }),
  };
}

test('IAM release registry resolves active workflow and verifies immutable binary digest', async () => {
  const f = fixture();
  assert.deepEqual(await f.releases.active('Example'), {
    workflowName: 'Example', sha256, protocolVersion: 2,
    allowedOperations: ['http.post'],
  });
  const binary = await f.releases.materialize(sha256);
  try {
    assert.deepEqual(await readFile(binary.executable), elf);
  } finally { await binary.cleanup(); }
  await assert.rejects(readFile(binary.executable), { code: 'ENOENT' });
  assert.deepEqual(f.reads, [
    'native-workflows/active/Example.json',
    'native-workflows/artifacts/' + sha256 + '.bin',
  ]);
});

test('IAM-published release capability enables globals without changing existing releases', async () => {
  const f = fixture({ manifest: { ...metadata, trustedGlobalsVersion: 1 } });
  assert.deepEqual(await f.releases.active('Example'), {
    workflowName: 'Example', sha256, protocolVersion: 2,
    allowedOperations: ['http.post'], trustedGlobalsVersion: 1,
  });
  f.objects.set('native-workflows/active/Example.json',
    Buffer.from(JSON.stringify({ ...metadata, trustedGlobalsVersion: 7 })));
  await assert.rejects(f.releases.active('Example'), /invalid IAM-published native release manifest/);
});

test('only an absent active mapping falls back; permission errors never downgrade', async () => {
  const f = fixture();
  assert.equal(await f.releases.active('NotPublished'), null);
  f.objects.set('native-workflows/active/Example.json', Buffer.from('not-json'));
  await assert.rejects(f.releases.active('Example'), /invalid IAM-published native release JSON/);
  f.objects.set('native-workflows/active/Example.json',
    Buffer.from(JSON.stringify({ ...metadata, protocolVersion: 1 })));
  await assert.rejects(f.releases.active('Example'), /invalid IAM-published native release manifest/);
  const forbidden = {
    bucket: () => ({ file: () => ({
      getMetadata: async () => { throw Object.assign(new Error('forbidden'), { code: 403 }); },
    }) }),
  };
  await assert.rejects(new NativeGcsReleases({
    storage: forbidden, bucket: 'test-native-artifacts',
  }).active('Example'), /forbidden/);
});

test('rejects caller-controlled paths, corrupt binaries and unapproved operations', async () => {
  const f = fixture();
  for (const name of ['../secret', '', 'Example/../a', '.env', 'Example.name']) {
    await assert.rejects(f.releases.active(name), /invalid native workflow release name/);
  }
  f.objects.set('native-workflows/active/Example.json', Buffer.from(JSON.stringify({
    ...metadata, allowedOperations: ['http.post', 'shell.run'],
  })));
  await assert.rejects(f.releases.active('Example'), /invalid IAM-published native release manifest/);
  f.objects.set('native-workflows/artifacts/' + sha256 + '.bin', Buffer.from('tampered'));
  await assert.rejects(f.releases.materialize(sha256), /SHA-256 mismatch/);
  const notELF = Buffer.from('#!/bin/sh\\nexit 0');
  const itsHash = hash(notELF);
  f.objects.set('native-workflows/artifacts/' + itsHash + '.bin', notELF);
  await assert.rejects(f.releases.materialize(itsHash), /must be a Linux ELF/);
  await assert.rejects(f.releases.materialize('../../bad'), /pinned native artifact digest required/);
});
