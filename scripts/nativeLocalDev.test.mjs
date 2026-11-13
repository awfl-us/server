import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createInMemoryFirestore, createReplayHttpHandlers, localReleases,
} from './nativeLocalDev.mjs';

test('local native transaction adapter serializes concurrent fork lane commits', async () => {
  const db = createInMemoryFirestore();
  const ref = db.collection('executions').doc('root');
  await db.runTransaction(async tx => tx.create(ref, { count: 0 }));
  await Promise.all(Array.from({ length: 15 }, () =>
    db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const previous = snap.data().count;
      await Promise.resolve();
      tx.update(ref, { count: previous + 1 });
    })));
  assert.equal((await ref.get()).data().count, 15);
});

test('replay requires trusted user, canonical Jobs target, and an actual recorded effect', async () => {
  const identity = { userId: 'user', projectId: 'project' };
  const seen = [], missing = [];
  const handlers = createReplayHttpHandlers({
    fixtures: { 'call_0': { code: 200, body: { ok: true } } },
    identity, seen, missing,
  });
  const base = {
    args: { url: 'https://jobs-4wmfqir74q-uc.a.run.app/events',
      auth: { type: 'OIDC' } },
    identity, idempotencyKey: 'native_' + 'f'.repeat(32) + ':root:call_0',
  };
  assert.deepEqual(await handlers['http.post'](base),
    { code: 200, body: { ok: true } });
  assert.equal(seen.length, 1);
  await assert.rejects(handlers['http.post']({
    ...base, identity: { userId: 'attacker', projectId: 'project' },
  }), /scope/);
  await assert.rejects(handlers['http.post']({
    ...base, args: { url: 'https://untrusted.example/events' },
  }), /scope/);
  await assert.rejects(handlers['http.post']({
    ...base, idempotencyKey: 'native_' + 'f'.repeat(32) + ':root:missing_0',
  }), /unrecorded Jobs effect/);
  assert.equal(missing.length, 1);
});

test('real local compiler manifest and binary integrity validated when build report supplied',
  { skip: !process.env.AWFL_NATIVE_LOCAL_BUILD_REPORT }, async () => {
    const releases = await localReleases(process.env.AWFL_NATIVE_LOCAL_BUILD_REPORT);
    assert.ok(releases.names.length >= 20);
    const root = await releases.active('codebase-ProjectManager');
    assert.equal(root.parallelVersion, 1);
    const artifact = await releases.materialize(root.sha256);
    assert.equal(typeof artifact.executable, 'string');
  });
