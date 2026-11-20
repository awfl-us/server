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
      if (op === '>=') return data[field] >= value;
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

  test('SegKala includes the first user message exactly on the lower boundary, without widening summary reads', async () => {
    const firstMessage = 1795198050.258966;
    const segmentEnd = firstMessage + 1200;
    STUB_COLLECTION_DOCS.set('convo.sessions/first-session/messages', [
      makeDoc('first', { create_time: firstMessage,
        value: { role: 'user', content: 'First user request' } }),
      makeDoc('reply', { create_time: firstMessage + 5,
        value: { role: 'assistant', content: 'First answer' } }),
      makeDoc('out-of-window', { create_time: firstMessage - 0.001,
        value: { role: 'user', content: 'Before window' } }),
    ]);
    STUB_COLLECTION_DOCS.set('convo.sessions/first-session/summaries', [
      makeDoc('prior', { create_time: firstMessage,
        value: { title: 'Earlier summary' } }),
    ]);
    const kala = { kind: 'SegKala', sessionId: 'first-session',
      end: segmentEnd, windowSeconds: 1200 };
    const args = { kala, userId: 'user-1', projectId: 'proj-1' };
    const messages = await buildYojMessages({ ...args, name: 'messages' });
    const summaries = await buildYojMessages({ ...args, name: 'summaries' });
    expect(messages.map(m => m.content)).toEqual(['First user request', 'First answer']);
    expect(summaries).toEqual([]);
  });

  test('SessionKala reads only segment summaries from the current session and 8-hour interval', async () => {
    const end = 1795205010.258966;
    STUB_COLLECTION_DOCS.set('convo.sessions/s1/summaries', [
      makeDoc('older', { create_time: end - 9 * 3600, value: { title: 'Outside interval' } }),
      makeDoc('first', { create_time: end - 2 * 3600, value: { title: 'Earlier segment' } }),
      makeDoc('latest', { create_time: end, value: { title: 'Current segment' } }),
      makeDoc('future', { create_time: end + 1, value: { title: 'Future segment' } }),
    ]);
    const res = await buildYojMessages({ name: 'summaries',
      kala: { kind: 'SessionKala', sessionId: 's1', sessionEnd: end },
      userId: 'user-1', projectId: 'proj-1' });
    expect(res.map(m => JSON.parse(m.content.replace(/^\(Session\)\s*/, '')).title))
      .toEqual(['Earlier segment', 'Current segment']);
  });

  test('TermKala aggregates weekly summaries only from its term interval', async () => {
    const begin = 1_700_000_000, end = begin + 91 * 86400;
    STUB_COLLECTION_DOCS.set('log.weekly.summaries', [
      makeDoc('before', { create_time: begin, value: { title: 'Older term' } }),
      makeDoc('inside', { create_time: begin + 604800, value: { title: 'This term' } }),
      makeDoc('after', { create_time: end + 1, value: { title: 'Future term' } }),
    ]);
    const res = await buildYojMessages({ name: 'summaries',
      kala: { kind: 'TermKala', begin, end }, userId: 'user-1', projectId: 'proj-1' });
    expect(res.map(m => JSON.parse(m.content.replace(/^\(Term\)\s*/, '')).title))
      .toEqual(['This term']);
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
