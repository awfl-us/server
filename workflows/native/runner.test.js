import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNativeArtifact, executePureNative } from './runner.js';

test('verified native executable receives JSON and returns result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'awfl-native-'));
  try {
    const executable = join(dir, 'workflow');
    const contents = '#!/usr/bin/env node\nlet s=""; process.stdin.on("data", x => s += x); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ value: JSON.parse(s).value + 1 })));\n';
    await writeFile(executable, contents); await chmod(executable, 0o700);
    const sha256 = createHash('sha256').update(contents).digest('hex');
    assert.deepEqual(await runNativeArtifact({ executable, sha256, input: { value: 7 } }), { value: 8 });
    await assert.rejects(runNativeArtifact({ executable, sha256: 'f'.repeat(64), input: {} }), /SHA-256 mismatch/);
    await assert.rejects(runNativeArtifact({ executable, sha256, input: { value: 7 }, timeoutMs: 1 }), /timeout/);
    const calls = [];
    const store = {
      claim: async () => ({ epoch: 2, artifactSha256: sha256, input: { value: 4 } }),
      complete: async value => calls.push(value),
    };
    assert.deepEqual(await executePureNative({ store, executionId: 'e1', workerId: 'w1', executable, sha256 }), { completed: true, result: { value: 5 } });
    assert.equal(calls[0].epoch, 2);
    await assert.rejects(executePureNative({ store, executionId: 'e1', workerId: 'w1', executable, sha256: 'f'.repeat(64) }), /pinned artifact mismatch/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
