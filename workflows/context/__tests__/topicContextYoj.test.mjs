import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

// Helper to set up mocks and import the router fresh per test (ESM)
async function setupTest({ decoderReturn, promoteKalaImpl, buildYojImpl, applyFiltersImpl, userIdFromReqImpl } = {}) {
  jest.resetModules();

  const routerUrl = new URL('../topicContextYoj.js', import.meta.url);
  const prakriyaPath = new URL('./lib/prakriya.js', routerUrl).pathname;
  const modelDecoderPath = new URL('./modelDecoder.js', routerUrl).pathname;
  const filtersIndexPath = new URL('./filters/index.js', routerUrl).pathname;
  const userAuthPath = new URL('../../jobs/userAuth.js', routerUrl).pathname;

  const promoteKala = jest.fn(promoteKalaImpl || ((k) => {
    if (!k || !k.kind) return null;
    switch (k.kind) {
      case 'SegKala':
        return { kind: 'SessionKala', sessionId: k.sessionId, sessionEnd: k.end };
      case 'SessionKala':
        return { kind: 'WeekKala', weekEnd: 2000 };
      case 'WeekKala':
        return { kind: 'TermKala', begin: 0, end: 3000 };
      case 'TermKala':
      default:
        return null;
    }
  }));

  const buildYojMessages = jest.fn(buildYojImpl || (async ({ name, kala, framing = '', includeDocId = false }) => {
    const base = { role: 'system', content: `${framing}${name}-${kala?.kind}` };
    return [includeDocId ? { ...base, docId: `${name}-${kala?.kind}-id` } : base];
  }));

  const decodeContextModel = jest.fn(() => (decoderReturn || {
    kala: { kind: 'SegKala', sessionId: 'sess-123', end: 1000, windowSeconds: 600 },
    model: {
      intro: { system: 'intro' },
      promoteUpstream: true,
      components: [ { kind: 'yoj', name: 'summaries', framing: 'F: ' } ],
      filters: [ { name: 'sizeLimiter' }, { name: 'toolCallBackfill' } ],
    },
  }));

  const applyFilters = jest.fn(applyFiltersImpl || (async (messages, pipeline, ctx) => {
    // Echo pipeline name list and append a ctx marker for assertions
    const names = (pipeline || []).map((p) => (typeof p === 'string' ? p : p?.name)).join(',');
    return messages.concat([{ role: 'system', content: `filters:[${names}] ctx:${ctx.sessionId}/${ctx.userId}/${ctx.projectId}` }]);
  }));

  const getUserIdFromReq = jest.fn(userIdFromReqImpl || (async () => 'user-xyz'));

  jest.unstable_mockModule(prakriyaPath, () => ({
    promoteKala,
    buildYojMessages,
  }));
  jest.unstable_mockModule(modelDecoderPath, () => ({
    decodeContextModel,
  }));
  jest.unstable_mockModule(filtersIndexPath, () => ({
    applyFilters,
  }));
  jest.unstable_mockModule(userAuthPath, () => ({
    getUserIdFromReq,
  }));

  const { default: router } = await import(routerUrl.pathname);

  const app = express();
  app.use(express.json());
  // Provide projectId expected by the route
  app.use((req, _res, next) => { req.projectId = 'proj-42'; next(); });
  app.use('/context', router);

  return { app, mocks: { promoteKala, buildYojMessages, decodeContextModel, applyFilters, getUserIdFromReq } };
}


describe('TopicContextYoj router - Yoj and Ista reads', () => {
  test('Yoj: intro + upstream promotion + local messages; includeDocId and filter ctx', async () => {
    const { app, mocks } = await setupTest({});

    const res = await request(app)
      .post('/context/topicContextYoj/run')
      .send({ includeDocId: true, userId: 'user-xyz' })
      .expect(200);

    const { yoj } = res.body;
    expect(Array.isArray(yoj)).toBe(true);

    // Expect order: intro, Term, Week, Session, Seg, then filter ctx marker
    expect(yoj.map(m => m.content)).toEqual([
      'intro',
      'F: summaries-TermKala',
      'F: summaries-WeekKala',
      'F: summaries-SessionKala',
      'F: summaries-SegKala',
      'filters:[sizeLimiter,toolCallBackfill] ctx:sess-123/user-xyz/proj-42',
    ]);

    // Ensure includeDocId propagated to buildYoj calls and present on non-intro messages
    expect(mocks.buildYojMessages).toHaveBeenCalledTimes(4);
    const callKinds = mocks.buildYojMessages.mock.calls.map(([args]) => args.kala.kind);
    // Call order from deepest to shallowest promotions, then local SegKala
    expect(callKinds).toEqual(['TermKala', 'WeekKala', 'SessionKala', 'SegKala']);
    for (const call of mocks.buildYojMessages.mock.calls) {
      expect(call[0].includeDocId).toBe(true);
      expect(call[0].name).toBe('summaries');
    }

    // All generated messages except intro should have docId when includeDocId is true (as per our mock)
    const withDocIds = yoj.slice(1, 5);
    for (const m of withDocIds) {
      expect(m.docId).toBeDefined();
    }

    // Filter ctx contains sessionId/userId/projectId
    expect(yoj[yoj.length - 1].content).toContain('ctx:sess-123/user-xyz/proj-42');

    // Verify filter was invoked with pipeline from decoder
    expect(mocks.applyFilters).toHaveBeenCalledTimes(1);
    const [messagesPassed, pipelinePassed, ctxPassed] = mocks.applyFilters.mock.calls[0];
    expect(Array.isArray(messagesPassed)).toBe(true);
    expect((pipelinePassed || []).map((p) => (typeof p === 'string' ? p : p?.name))).toEqual(['sizeLimiter', 'toolCallBackfill']);
    expect(ctxPassed).toMatchObject({ sessionId: 'sess-123', userId: 'user-xyz', projectId: 'proj-42' });
  });

  test('Ista: nested components (DFS leaves only); no upstream; framing preserved', async () => {
    const decoderReturn = {
      kala: { kind: 'SegKala', sessionId: 'sess-abc', end: 1111, windowSeconds: 300 },
      model: {
        promoteUpstream: false,
        components: [
          {
            kind: 'yoj',
            name: 'topicInfos',
            children: [
              { kind: 'literal', value: 'literal-intro' },
              { kind: 'ista', name: 'messages', framing: 'I: ' },
            ],
          },
        ],
        filters: [ { name: 'toolCallBackfill' } ],
      },
    };

    const { app, mocks } = await setupTest({ decoderReturn });

    const res = await request(app)
      .post('/context/topicContextYoj/run')
      .send({ includeDocId: false, userId: 'user-abc' })
      .expect(200);

    const { yoj } = res.body;
    expect(yoj.map(m => m.content)).toEqual([
      'literal-intro', // literal leaf emitted first (DFS)
      'I: messages-SegKala', // ista leaf handled like yoj
      'filters:[toolCallBackfill] ctx:sess-abc/user-abc/proj-42',
    ]);

    // Only one build call for the ista leaf, with framing preserved and includeDocId=false
    expect(mocks.buildYojMessages).toHaveBeenCalledTimes(1);
    const [args] = mocks.buildYojMessages.mock.calls[0];
    expect(args).toMatchObject({ name: 'messages', framing: 'I: ', includeDocId: false });
    expect(args.kala.kind).toBe('SegKala');

    // Upstream promotion should not have been attempted when promoteUpstream=false
    expect(mocks.promoteKala).not.toHaveBeenCalled();

    // Filter ctx reflects sessionId/userId/projectId of this request
    const last = yoj[yoj.length - 1];
    expect(last.content).toContain('ctx:sess-abc/user-abc/proj-42');
  });
});
