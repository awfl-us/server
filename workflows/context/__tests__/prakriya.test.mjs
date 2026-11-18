/*
  Unit tests for prakriya.js focusing on WeekKala behavior.
  - Tests buildYojMessages without mocking it (we mock Firebase Admin and Firestore only).
  - Ensures WeekKala pulls from log.sessions.{name} and returns all session docs in the window.
  - Verifies messages gating (messages only for SegKala) remains intact.
*/

import { jest } from '@jest/globals';

// Stub data registry keyed by collection path (post projectScopedCollectionPath)
const STUB_COLLECTION_DOCS = new Map();

// Mock project scoping and the current provider-neutral Storage boundary.
// The old Firestore Admin query mock no longer represents this code path.
jest.unstable_mockModule('../../userAuth.js', () => ({
  projectScopedCollectionPath: (_userId, _projectId, collectionPath) => collectionPath,
}));

jest.unstable_mockModule('../../../storage/service.js', () => ({
  getDocumentStorage: async () => ({ listCollections: async () => [] }),
  readDocuments: async (_store, { collection, where = [] }) => {
    const docs = STUB_COLLECTION_DOCS.get(collection) || [];
    return docs.filter(({ data }) => where.every(({ field, op, value }) => {
      if (op === '>') return data[field] > value;
      if (op === '<=') return data[field] <= value;
      if (op === '==') return data[field] === value;
      throw new Error(`Unexpected operator: ${op}`);
    })).map(({ id, data }) => ({ id, path: `${collection}/${id}`, data: { ...data } }));
  },
}));

// Import the module under test AFTER setting up the mocks
const prakriya = await import('../lib/prakriya.js');
const { buildYojMessages, WEEK_SECONDS, promoteKala } = prakriya;
const { interleaveContextMessages } = await import('../lib/chronologicalMessages.js');

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

  test('document wrapper timestamps interleave real summaries and chat without leaking metadata', async () => {
    const now = 1_000_000;
    const docs = (items) => items.map(([id, at, value]) => makeDoc(id, {
      create_time: at, value,
    }));
    STUB_COLLECTION_DOCS.set('convo.sessions/s1/summaries', docs([
      ['s2', now - 30, { title: 'Later summary' }],
      ['s1', now - 250, { title: 'Earlier summary' }],
    ]));
    STUB_COLLECTION_DOCS.set('convo.sessions/s1/messages', docs([
      ['m1', now - 300, { role: 'user', content: 'Older chat' }],
      ['m2', now - 150, { role: 'assistant', content: 'Middle chat' }],
      ['m3', now - 10, { role: 'user', content: 'Latest chat' }],
    ]));
    const params = { kala: { kind: 'SegKala', sessionId: 's1', end: now,
      windowSeconds: 400 }, userId: 'user-1', projectId: 'proj-1', includeDocId: true };
    const summaries = await buildYojMessages({ ...params, name: 'summaries',
      framing: 'Previous convo summaries: ' });
    const messages = await buildYojMessages({ ...params, name: 'messages' });
    const result = interleaveContextMessages([...summaries, ...messages]);
    expect(result.map(m => m.docId)).toEqual(['m1', 's1', 'm2', 's2', 'm3']);
    expect(result.map(m => m.role)).toEqual(['user', 'system', 'assistant', 'system', 'user']);
    expect(result[1].content).toContain('Earlier summary');
    expect(result[3].content).toContain('Later summary');
    expect(result.every(m => !Object.keys(m).includes('create_time'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('create_time');
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
