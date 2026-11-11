import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeArtifactRegistry } from './artifactRegistry.js';
import { executeRegisteredNativeStep, runNativeArtifact } from './runner.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture({ script, allowedOperations = ['http.post'], protocolVersion = 2 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'awfl-approved-'));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const code = script || `#!${process.execPath}
let text = '';
process.stdin.on('data', x => text += x);
process.stdin.on('end', () => process.stdout.write(JSON.stringify({
  protocol_version: 2, status: 'suspended',
  effect: {
    effect_id: 'call_0', node_id: '0.0', operation: 'http.post',
    args: { url: 'https://example.invalid' }, result_slot: 's0'
  },
  continuation: { next_step: 0, slots: {}, frames: [] }
})));
`;
  const bytes = Buffer.from(code);
  const sha256 = digest(bytes);
  const binary = join(root, sha256 + '.bin');
  const approval = join(root, sha256 + '.approval.json');
  const manifest = {
    schemaVersion: 1, publisherKeyId: 'ci',
    artifactSha256: sha256, protocolVersion,
    runtimeAbi: protocolVersion === 2 ? 3 : 2,
    allowedOperations,
  };
  const envelope = () => ({
    manifest,
    signature: sign(null, Buffer.from(JSON.stringify(manifest)), privateKey).toString('base64'),
  });
  await writeFile(binary, bytes, { mode: 0o500 });
  await writeFile(approval, JSON.stringify(envelope()), { mode: 0o400 });
  const registry = new NativeArtifactRegistry({
    directory: root, trustedPublishers: { ci: publicKey },
    allowScriptsForTests: true,
  });
  return {
    root, binary, approval, registry, sha256, manifest, envelope,
    destroy: () => rm(root, { recursive: true, force: true }),
  };
}

test('signed registry requires the pinned publisher, binary digest and ABI', async () => {
  const f = await fixture();
  try {
    const found = await f.registry.resolve({ sha256: f.sha256, protocolVersion: 2 });
    assert.equal(found.executable, f.binary);
    assert.deepEqual(found.allowedOperations, ['http.post']);
    assert.equal(found.publisherKeyId, 'ci');
    await assert.rejects(f.registry.resolve({
      sha256: f.sha256, protocolVersion: 1,
    }), /approval protocol differs/);
    await assert.rejects(f.registry.resolve({
      sha256: '../unsafe', protocolVersion: 2,
    }), /pinned artifact SHA-256/);
    const forged = {
      ...f.envelope(), manifest: { ...f.manifest, allowedOperations: ['http.patch'] },
    };
    await chmod(f.approval, 0o600);
    await writeFile(f.approval, JSON.stringify(forged));
    await assert.rejects(f.registry.resolve({
      sha256: f.sha256, protocolVersion: 2,
    }), /signature not trusted/);
    await writeFile(f.approval, JSON.stringify(f.envelope()));
    await chmod(f.binary, 0o600);
    await writeFile(f.binary, 'tampered');
    await assert.rejects(f.registry.resolve({
      sha256: f.sha256, protocolVersion: 2,
    }), /binary SHA-256 mismatch/);
  } finally { await f.destroy(); }
});

test('registry rejects an unknown signer, symlinked artifact and absent approval', async () => {
  const f = await fixture();
  try {
    const productionRegistry = new NativeArtifactRegistry({
      directory: f.root, trustedPublishers: { ci: f.registry.trustedKeys.get('ci') },
    });
    await assert.rejects(productionRegistry.resolve({
      sha256: f.sha256, protocolVersion: 2,
    }), /Linux ELF executable/);
    const otherKey = generateKeyPairSync('ed25519').publicKey;
    const untrusted = new NativeArtifactRegistry({
      directory: f.root, trustedPublishers: { other: otherKey },
    });
    await assert.rejects(untrusted.resolve({
      sha256: f.sha256, protocolVersion: 2,
    }), /signature not trusted/);
    await rm(f.binary);
    const elsewhere = join(f.root, 'elsewhere');
    await writeFile(elsewhere, 'malicious');
    await symlink(elsewhere, f.binary);
    await assert.rejects(f.registry.resolve({ sha256: f.sha256, protocolVersion: 2 }));
    await rm(f.binary);
    await rm(f.approval);
    await assert.rejects(f.registry.resolve({ sha256: f.sha256, protocolVersion: 2 }));
    assert.throws(() => new NativeArtifactRegistry({
      directory: f.root, trustedPublishers: {},
    }), /trusted publisher/);
  } finally { await f.destroy(); }
});

test('runner executes a private snapshot without inheriting credentials', async () => {
  const script = `#!${process.execPath}
const fs = require('node:fs');
let text = '';
process.stdin.on('data', x => text += x);
process.stdin.on('end', () => process.stdout.write(JSON.stringify({
  input: JSON.parse(text),
  token: process.env.AWFL_NATIVE_TEST_TOKEN ?? null,
  cwd: process.cwd(),
  file: process.argv[1],
  staged: fs.existsSync(process.argv[1])
})));
`;
  const f = await fixture({ script });
  const previous = process.env.AWFL_NATIVE_TEST_TOKEN;
  process.env.AWFL_NATIVE_TEST_TOKEN = 'secret-must-not-propagate';
  try {
    const output = await runNativeArtifact({
      executable: f.binary, sha256: f.sha256, input: { ok: true },
    });
    assert.deepEqual(output.input, { ok: true });
    assert.equal(output.token, null);
    assert.equal(output.staged, true);
    assert.notEqual(output.file, f.binary);
    assert.equal(output.cwd.startsWith(join(tmpdir(), 'awfl-native-exec-')), true);
    await assert.rejects(readFile(output.file), { code: 'ENOENT' });
    const link = join(f.root, 'link');
    await symlink(f.binary, link);
    await assert.rejects(runNativeArtifact({
      executable: link, sha256: f.sha256, input: {},
    }));
  } finally {
    if (previous === undefined) delete process.env.AWFL_NATIVE_TEST_TOKEN;
    else process.env.AWFL_NATIVE_TEST_TOKEN = previous;
    await f.destroy();
  }
});

test('registered runner selects from pinned state and checks signed capabilities', async () => {
  const f = await fixture();
  try {
    const prepared = [];
    const state = digestValue => ({
      artifactSha256: digestValue, protocolVersion: 2, input: null,
      epoch: 1, pendingEffect: null, checkpoint: null,
    });
    const store = {
      get: async () => state(f.sha256),
      claim: async () => state(f.sha256),
      prepareEffect: async value => prepared.push(value),
    };
    assert.deepEqual(await executeRegisteredNativeStep({
      store, registry: f.registry, executionId: 'run', workerId: 'worker',
    }), { status: 'waiting_effect', effectId: 'call_0' });
    assert.equal(prepared.length, 1);
    assert.equal(prepared[0].protocolVersion, 2);
    const restricted = await fixture({ allowedOperations: [] });
    try {
      const restrictedStore = {
        ...store,
        get: async () => state(restricted.sha256),
        claim: async () => state(restricted.sha256),
      };
      await assert.rejects(executeRegisteredNativeStep({
        store: restrictedStore, registry: restricted.registry,
        executionId: 'run', workerId: 'worker',
      }), /outside approved native artifact capabilities/);
    } finally { await restricted.destroy(); }
  } finally { await f.destroy(); }
});
