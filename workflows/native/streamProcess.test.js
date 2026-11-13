import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeStreamSession } from './streamProcess.js';
import { runNativeArtifact } from './runner.js';

const compiled = process.env.AWFL_NATIVE_STREAM_BINARY;
const hash = async file =>
  createHash('sha256').update(await readFile(file)).digest('hex');

test('compiled native v2 binary supports one-shot and repeated stream requests', {
  skip: !compiled, timeout: 30_000,
}, async () => {
  const sha256 = await hash(compiled);
  const oneShot = await runNativeArtifact({
    executable: compiled, sha256,
    input: { protocol_version: 2, input: 1 },
  });
  assert.deepEqual(oneShot, {protocol_version:2,status:'completed',result:2});
  const session = createNativeStreamSession({ executable: compiled, sha256 });
  try {
    const result = await session.run({protocol_version:2,input:1});
    assert.deepEqual(result, oneShot);
    assert.deepEqual(await session.run({protocol_version:2,input:13}),
      {protocol_version:2,status:'completed',result:14});
    const more = await Promise.all([
      session.run({protocol_version:2,input:20}),
      session.run({protocol_version:2,input:40}),
      session.run({protocol_version:2,input:60}),
    ]);
    assert.deepEqual(more.map(x=>x.result),[21,41,61]);
    assert.equal(session.spawnCount,1);
    assert.equal(session.requestCount,5);
  } finally { await session.close(); }
  await assert.rejects(session.run({protocol_version:2,input:1}), /closed/);
});

test('stream refuses untrusted binary hash before launch', {
  skip: !compiled, timeout: 15_000,
}, async () => {
  const session = createNativeStreamSession({
    executable:compiled, sha256:'a'.repeat(64),
  });
  try {
    await assert.rejects(session.run({protocol_version:2,input:1}),
      /SHA-256 mismatch/);
    assert.equal(session.spawnCount,0);
  } finally { await session.close(); }
});

test('malformed request fails closed and exits; no replay of child intent', {
  skip: !compiled, timeout: 15_000,
}, async () => {
  const session = createNativeStreamSession({
    executable:compiled,sha256:await hash(compiled),
  });
  try {
    await assert.rejects(session.run({protocol_version:999,input:1}),
      /exited|timeout/);
    await assert.rejects(session.run({protocol_version:2,input:1}),
      /exited|timeout/);
    assert.equal(session.spawnCount,1);
  } finally { await session.close(); }
});

test('one-stream process is killed and cleaned after response timeout', async () => {
  const dir = await mkdtemp(join(tmpdir(),'awfl-stream-test-'));
  const filename = join(dir,'stalled');
  const source = '#!/bin/sh\nread -r line\nwhile :; do :; done\n';
  await writeFile(filename,source,{mode:0o700});
  await chmod(filename,0o700);
  const sha256 = await hash(filename);
  const session = createNativeStreamSession({executable:filename,sha256,timeoutMs:80});
  try {
    await assert.rejects(session.run({protocol_version:2,input:{}}),
      /timeout/);
    assert.equal(session.spawnCount,1);
  } finally {
    await session.close();
    await rm(dir,{recursive:true,force:true});
  }
});

test('stream process is not shared across sessions or owners', {
  skip:!compiled,timeout:15000,
}, async () => {
  const sha256=await hash(compiled);
  const first=createNativeStreamSession({executable:compiled,sha256});
  const second=createNativeStreamSession({executable:compiled,sha256});
  try {
    assert.equal((await first.run({protocol_version:2,input:1})).result,2);
    assert.equal((await second.run({protocol_version:2,input:5})).result,6);
    assert.equal(first.spawnCount,1);
    assert.equal(second.spawnCount,1);
  } finally { await Promise.all([first.close(),second.close()]); }
});
