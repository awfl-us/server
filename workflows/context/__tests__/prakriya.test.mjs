/*
  Unit tests for prakriya.js focusing on WeekKala behavior.
  - Tests buildYojMessages without mocking it (we mock Firebase Admin and Firestore only).
  - Ensures WeekKala pulls from log.sessions.{name} and returns all session docs in the window.
  - Verifies messages gating (messages only for SegKala) remains intact.
*/

import { jest } from '@jest/globals';

// Stub data registry keyed by collection path (post projectScopedCollectionPath)
const STUB_COLLECTION_DOCS = new Map();

// Mock firebase-admin/app to avoid real initialization
jest.unstable_mockModule('firebase-admin/app', () => ({
  initializeApp: jest.fn(),
  getApps: () => [],
}));

// Mock projectScopedCollectionPath to return the raw collectionPath we pass in
jest.unstable_mockModule('../../userAuth.js', () => ({
  projectScopedCollectionPath: (userId, projectId, collectionPath) => collectionPath,
}));

// Mock firebase-admin/firestore with a minimal query chain used by listBetween and listBetweenFlat
jest.unstable_mockModule('firebase-admin/firestore', () => ({
  getFirestore: () => ({
    collection: (path) => {
      const chain = {
        _path: path,
        where() { return this; },
        orderBy() { return this; },
        async get() {
          const docs = STUB_COLLECTION_DOCS.get(path) || [];
          // Simulate Firestore's orderBy('create_time','asc') at query time
          const sorted = [...docs].sort((a, b) => {
            const at = a.data?.create_time ?? a.data?.createTime ?? a.data?.ts ?? 0;
            const bt = b.data?.create_time ?? b.data?.createTime ?? b.data?.ts ?? 0;
            return at - bt;
          });
          return {
            docs: sorted.map((d) => ({ id: d.id, data: () => ({ ...d.data }) })),
          };
        },
        async doc() { return { get: async () => ({ exists: false }) }; },
        async listCollections() { return []; },
      };
      return chain;
    },
  }),
}));

// Import the module under test AFTER setting up the mocks
const prakriya = await import('../lib/prakriya.js');
const { buildYojMessages, WEEK_SECONDS, promoteKala } = prakriya;

function makeDoc(id, { create_time, sessionId, value, extra = {} }) {
  return {
    id,
    data: {
      create_time,
      sessionId,
      value,
      ...extra,
    },
  };
}

describe('prakriya.buildYojMessages - WeekKala', () => {
  beforeEach(() => {
    STUB_COLLECTION_DOCS.clear();
  });

  test('returns all session docs for the week window from log.sessions.{name}', async () => {
    const weekEnd = 1_000_000;
    const weekBegin = weekEnd - WEEK_SECONDS;

    // Prepare unsorted docs (should be returned in asc order by mocked query)
    const docs = [
      makeDoc('s3', { create_time: weekBegin + 5000, sessionId: 'session-3', value: { foo: 'c' } }),
      makeDoc('s1', { create_time: weekBegin + 1000, sessionId: 'session-1', value: { foo: 'a' } }),
      makeDoc('s2', { create_time: weekBegin + 3000, sessionId: 'session-2', value: { foo: 'b' } }),
    ];

    STUB_COLLECTION_DOCS.set('log.sessions.summaries', docs);

    const res = await buildYojMessages({
      name: 'summaries',
      kala: { kind: 'WeekKala', weekEnd },
      userId: 'user-1',
      projectId: 'proj-1',
      framing: '',
    });

    expect(Array.isArray(res)).toBe(true);
    expect(res).toHaveLength(3);
    // Should be encoded as system messages with (Week) label and stringified value
    for (const msg of res) {
      expect(msg.role).toBe('system');
      expect(typeof msg.content).toBe('string');
      expect(msg.content.startsWith('(Week) ')).toBe(true);
    }
    // Asc by create_time (s1, s2, s3)
    const order = res.map((m) => JSON.parse(m.content.replace(/^\(Week\)\s*/, ''))?.foo);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  test('messages gating: messages for WeekKala returns empty list', async () => {
    const weekEnd = 1_000_000;
    STUB_COLLECTION_DOCS.set('log.sessions.messages', [
      makeDoc('m1', { create_time: weekEnd - 100, sessionId: 'session-1', value: { role: 'user', content: 'hi' } }),
    ]);

    const res = await buildYojMessages({
      name: 'messages',
      kala: { kind: 'WeekKala', weekEnd },
      userId: 'user-1',
      projectId: 'proj-1',
    });
    expect(res).toEqual([]);
  });
});

describe('prakriya.promoteKala', () => {
  test('Seg -> Session -> Week -> Term -> null chain', () => {
    const seg = { kind: 'SegKala', sessionId: 's', end: 2000, windowSeconds: 300 };
    const session = promoteKala(seg);
    expect(session).toMatchObject({ kind: 'SessionKala', sessionId: 's' });

    const week = promoteKala(session);
    expect(week).toMatchObject({ kind: 'WeekKala' });

    const term = promoteKala(week);
    expect(term).toMatchObject({ kind: 'TermKala' });

    const done = promoteKala(term);
    expect(done).toBeNull();
  });
});
