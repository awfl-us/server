import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeProjectHeader, resolveNativeProjectIdentity } from './projectScope.js';

const parent = Object.freeze({ userId: 'owner', projectId: 'parent' });

function storageFor(...ids) {
  const reads = [];
  return {
    reads,
    getStorage: async () => ({
      async get(path) {
        reads.push(path);
        return ids.map(id => `users/owner/projects/${id}`).includes(path)
          ? { data: { id: path.split('/').at(-1) } } : null;
      },
    }),
  };
}

test('same project keeps trusted identity without a database read', async () => {
  const result = await resolveNativeProjectIdentity(parent, {
    getStorage: async () => { throw new Error('should not query project store'); },
  });
  assert.strictEqual(result, parent);
  assert.strictEqual(await resolveNativeProjectIdentity(parent, {
    projectId: 'parent', userId: 'owner',
    getStorage: async () => { throw new Error('should not query project store'); },
  }), parent);
});

test('a second project is authorized only through the original user collection', async () => {
  const st = storageFor('temp');
  const result = await resolveNativeProjectIdentity(parent, {
    projectId: 'temp', userId: 'owner', getStorage: st.getStorage,
  });
  assert.deepEqual(result, { userId: 'owner', projectId: 'temp' });
  assert.deepEqual(st.reads, ['users/owner/projects/temp']);
  assert.notStrictEqual(result, parent);
  assert.deepEqual(parent, { userId: 'owner', projectId: 'parent' },
    'root execution identity remains immutable');
});

test('cross-user and missing project access fail closed', async () => {
  const st = storageFor('temp');
  await assert.rejects(resolveNativeProjectIdentity(parent, {
    projectId: 'temp', userId: 'attacker', getStorage: st.getStorage,
  }), /may not switch authenticated user/);
  assert.equal(st.reads.length, 0);
  await assert.rejects(resolveNativeProjectIdentity(parent, {
    projectId: 'foreign', getStorage: st.getStorage,
  }), /not owned/);
  assert.deepEqual(st.reads, ['users/owner/projects/foreign']);
});

test('invalid project identifiers cannot escape user-scoped paths', async () => {
  for (const projectId of ['../other', '', 'foo/bar', ' space', 'a'.repeat(129), 1, null]) {
    await assert.rejects(resolveNativeProjectIdentity(parent, {
      projectId, getStorage: storageFor('temp').getStorage,
    }), /invalid native target project/);
  }
});

test('missing or duplicated x-project-id headers are fail closed', () => {
  assert.equal(nativeProjectHeader(null), undefined);
  assert.equal(nativeProjectHeader({ 'x-user-id': 'forged' }), undefined);
  assert.equal(nativeProjectHeader({ 'X-Project-Id': 'temp' }), 'temp');
  assert.equal(nativeProjectHeader({ 'x-project-id': 'temp', 'X-PROJECT-ID': 'temp' }), 'temp');
  assert.throws(() => nativeProjectHeader({
    'x-project-id': 'temp', 'X-Project-ID': 'foreign',
  }), /conflicting/);
  assert.throws(() => nativeProjectHeader(['x-project-id', 'temp']), /invalid/);
});
