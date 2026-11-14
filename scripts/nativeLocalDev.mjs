/**
 * Fast, same-pod native compiler/runtime integration.
 * No production IAM bypass: actual Rust ELF, native fork/child and native
 * continuations; Jobs responses replay by effect ID, optional live GCS reads.
 */
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { NativeExecutionStore } from '../workflows/native/executionStore.js';
import { runNativeWorkflow } from '../workflows/native/worker.js';
import { runNativeMemoryWorkflow } from '../workflows/native/memoryWorker.js';
import { createNativeLogEffectHandler } from '../workflows/native/logEffects.js';
import { createNativeStorageEffectHandler } from '../workflows/native/storageEffects.js';
import { createNativeCallbackEffects } from '../workflows/native/callbackEffects.js';

const SHA = /^[a-f0-9]{64}$/;
const DEFAULT_ORIGIN = 'https://jobs-4wmfqir74q-uc.a.run.app';
const clone = structuredClone;

export function createInMemoryFirestore() {
  const docs = new Map();
  let pending = Promise.resolve();
  const watchers = new Map();
  const doc = key => ({
    key, path: key,
    async get() { return snapshot(key); },
    onSnapshot(notify) {
      const callbacks = watchers.get(key) || new Set();
      callbacks.add(notify);
      watchers.set(key, callbacks);
      queueMicrotask(() => notify(snapshot(key)));
      return () => callbacks.delete(notify);
    },
  });
  const snapshot = key => ({
    exists: docs.has(key),
    data: () => docs.has(key) ? clone(docs.get(key)) : undefined,
  });
  return {
    _docs: docs,
    collection: prefix => ({
      doc: name => doc(prefix + '/' + name),
      where(field, operator, expected) {
        if (operator !== '==' || typeof field !== 'string') {
          throw new Error('unsupported local Firestore query');
        }
        return {
          limit(count) {
            return { async get() {
              const docsFound = [...docs.entries()]
                .filter(([key, value]) =>
                  key.startsWith(prefix + '/') &&
                  !key.slice(prefix.length + 1).includes('/') &&
                  value[field] === expected)
                .slice(0, count)
                .map(([key, data]) => ({
                  id: key.slice(prefix.length + 1),
                  data: () => clone(data),
                }));
              return { docs: docsFound };
            } };
          },
        };
      },
    }),
    doc,
    async runTransaction(fn) {
      const previous = pending;
      let unlock;
      pending = new Promise(resolve => { unlock = resolve; });
      await previous;
      const writes = [];
      try {
        const tx = {
          get: async ref => snapshot(ref.key),
          create: (ref, data) => {
            if (docs.has(ref.key)) throw new Error('already exists: ' + ref.key);
            writes.push(['create', ref.key, clone(data)]);
          },
          update: (ref, data) => {
            if (!docs.has(ref.key)) throw new Error('missing: ' + ref.key);
            writes.push(['update', ref.key, clone(data)]);
          },
        };
        const result = await fn(tx);
        for (const [op, key, data] of writes) {
          docs.set(key, op === 'update' ? { ...docs.get(key), ...data } : data);
          for (const notify of watchers.get(key) || []) {
            const change = snapshot(key);
            queueMicrotask(() => notify(change));
          }
        }
        return result;
      } finally { unlock(); }
    },
  };
}

export async function localReleases(reportPath) {
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const byName = new Map(), bySha = new Map();
  for (const [name, record] of Object.entries(report)) {
    const manifest = JSON.parse(await readFile(record.manifest, 'utf8'));
    const binary = await readFile(record.binary);
    const actual = createHash('sha256').update(binary).digest('hex');
    if (!SHA.test(record.sha256) || actual !== record.sha256 ||
        manifest.workflow !== name || manifest.runtime_abi !== 3) {
      throw new Error('local artifact integrity mismatch: ' + name);
    }
    const release = {
      workflowName: name, sha256: actual, protocolVersion: 2,
      allowedOperations: Object.freeze(record.operations),
      ...(manifest.parallel_version === 1 && { parallelVersion: 1 }),
      ...(manifest.trusted_globals_version === 1 && { trustedGlobalsVersion: 1 }),
      ...(manifest.stream_ipc_version === 1 && { streamIpcVersion: 1 }),
    };
    byName.set(name, release);
    bySha.set(actual, {
      executable: record.binary, sha256: actual, cleanup: async () => {},
    });
  }
  return {
    active: async name => byName.get(name) || null,
    materialize: async sha => {
      const artifact = bySha.get(sha);
      if (!artifact) throw new Error('local release binary unavailable: ' + sha);
      return artifact;
    },
    names: [...byName.keys()],
  };
}

export function createReplayHttpHandlers({ fixtures, identity,
    jobsOrigin = DEFAULT_ORIGIN, seen, missing }) {
  const expected = new URL(jobsOrigin);
  const operations = {
    'http.get': 'GET', 'http.post': 'POST',
    'http.patch': 'PATCH', 'http.delete': 'DELETE',
  };
  return Object.fromEntries(Object.entries(operations).map(([op, method]) => [
    op,
    async ({ args, identity: actual, idempotencyKey }) => {
      const url = new URL(args.url);
      if (url.origin !== expected.origin ||
          (args.auth !== undefined && args.auth?.type !== 'OIDC') ||
          actual.userId !== identity.userId ||
          actual.projectId !== identity.projectId) {
        throw new Error('local replay request outside trusted Jobs scope');
      }
      const effectId = idempotencyKey.split(':').at(-1);
      const path = url.pathname;
      seen.push({ op, path, effectId });
      const saved = fixtures[effectId];
      if (!saved) {
        const description = method + ' ' + path + ' (' + effectId + ')';
        missing.push(description);
        throw new Error('unrecorded Jobs effect in local replay: ' + description);
      }
      if (saved.code < 200 || saved.code > 299) {
        const error = new Error('recorded Jobs HTTP ' + saved.code);
        error.status = saved.code;
        throw error;
      }
      return clone(saved);
    },
  ]));
}

/**
 * Run native HTTP effects against the actual local Jobs Express application.
 * Only a pinned production Jobs origin may be redirected, and the destination
 * is loopback-only. The upstream identity is supplied from trusted execution,
 * never from arbitrary DSL args.
 */
export function createLocalJobsHttpHandlers({
  identity, jobsOrigin = DEFAULT_ORIGIN, localJobsUrl, seen, missing = [],
  timeoutMs = 120000, failedRequests = [],
}) {
  const local = new URL(localJobsUrl);
  const expected = new URL(jobsOrigin);
  if (local.protocol !== 'http:' ||
      !['127.0.0.1','localhost','[::1]'].includes(local.hostname) ||
      local.username || local.password || local.search || local.hash ||
      local.pathname !== '/' || !/^[0-9]+$/.test(local.port) ||
      expected.protocol !== 'https:' || expected.pathname !== '/') {
    throw new Error('local Jobs mode requires explicit loopback HTTP and trusted production origin');
  }
  const methods = {
    'http.get': 'GET', 'http.post': 'POST',
    'http.patch': 'PATCH', 'http.delete': 'DELETE',
  };
  return Object.fromEntries(Object.entries(methods).map(([operation, method]) =>
    [operation, async ({args, identity: actual, idempotencyKey}) => {
      const original = new URL(args.url);
      if (original.origin !== expected.origin ||
          original.username || original.password || original.hash ||
          original.pathname.startsWith('//') ||
          (args.auth != null && args.auth.type !== 'OIDC') ||
          actual?.userId !== identity.userId ||
          actual?.projectId !== identity.projectId) {
        throw new Error('local Jobs effect must target the trusted Jobs origin and owner');
      }
      const effectId = idempotencyKey.split(':').at(-1);
      seen.push({op: operation, path:original.pathname, effectId});
      const url = new URL(original.pathname + original.search, local);
      const body = Object.hasOwn(args,'body')
        ? args.body && typeof args.body === 'object' && !Array.isArray(args.body)
          ? {...args.body, userId: identity.userId, projectId: identity.projectId}
          : args.body
        : undefined;
      const response = await fetch(url, {
        method, redirect: 'manual',
        headers: {
          'x-user-id':identity.userId,
          'x-project-id':identity.projectId,
          'x-awfl-idempotency-key':idempotencyKey,
          ...(body !== undefined ? {'content-type':'application/json'} : {}),
        },
        ...(body !== undefined ? {body:JSON.stringify(body)} : {}),
        signal:AbortSignal.timeout(timeoutMs),
      });
      const raw = await response.text();
      let content = raw;
      try {content = raw ? JSON.parse(raw) : null} catch {}
      if (!response.ok) {
        failedRequests.push({method, path: original.pathname, status:response.status,
          response: (typeof content === 'string' ? content : JSON.stringify(content)).slice(0, 300)});
        const error = new Error('local Jobs ' + method + ' ' + original.pathname +
          ' returned HTTP ' + response.status + ' (not a replay fixture)');
        error.status = response.status;
        throw error;
      }
      return {code:response.status,body:content};
    }],
  ));
}

export function createLiveGcsStorage(tokenFile) {
  const request = async (bucket, object, fields) => {
    const token = (await readFile(tokenFile, 'utf8')).trim();
    const url = 'https://storage.googleapis.com/storage/v1/b/' +
      encodeURIComponent(bucket) + '/o/' + encodeURIComponent(object) +
      (fields ? '?fields=size' : '?alt=media');
    const response = await fetch(url, {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('authenticated GCS HTTP ' + response.status);
    return fields ? response.json() : Buffer.from(await response.arrayBuffer());
  };
  return {
    bucket: name => ({ file: object => ({
      getMetadata: async () => [await request(name, object, true)],
      download: async () => [await request(name, object, false)],
    }) }),
  };
}

export async function runLocalProjectManager({
  reportPath, input, fixtures = {}, identity, tokenFile = null,
  jobsOrigin = DEFAULT_ORIGIN, localJobsUrl = null, maxTransitions = 120,
  executionMode = 'durable', log = console.log,
}) {
  if (!identity?.userId || !identity?.projectId) {
    throw new Error('explicit authenticated development identity required');
  }
  const releases = await localReleases(reportPath);
  const root = await releases.active('codebase-ProjectManager');
  if (!root || root.parallelVersion !== 1) {
    throw new Error('missing ProjectManager native parallel root');
  }
  const executionId = 'native_' + randomUUID().replaceAll('-', '');
  const db = createInMemoryFirestore();
  const store = new NativeExecutionStore({ db });
  await store.create({
    executionId, userId: identity.userId, projectId: identity.projectId,
    workflowName: 'codebase-ProjectManager', artifactSha256: root.sha256,
    protocolVersion: 2, allowedOperations: [...root.allowedOperations],
    ...(root.parallelVersion === 1 && { parallelVersion: 1 }),
    ...(root.trustedGlobalsVersion === 1 && { trustedGlobalsVersion: 1 }),
    ...(root.streamIpcVersion === 1 && { streamIpcVersion: 1 }),
    ...(executionMode === 'memory' && { executionMode: 'memory' }),
    input,
  });
  const seen = [], missing = [], storageErrors = [], failedRequests = [];
  const http = localJobsUrl
    ? createLocalJobsHttpHandlers({identity, jobsOrigin, localJobsUrl,
      seen, missing, failedRequests})
    : createReplayHttpHandlers({fixtures, identity, jobsOrigin, seen, missing});
  const realStorage = tokenFile ? createNativeStorageEffectHandler({
    storage: createLiveGcsStorage(tokenFile),
  }) : null;
  // Same native callback service and Firestore records used by Cloud Run.
  // Only enabled for explicitly local Jobs runs with the existing GKE
  // user-scoped credential preloader.
  let callbackHandlers = {};
  if (localJobsUrl) {
    // This is a standalone test CLI, unlike the normal Jobs Express
    // application which initializes Firebase before mounting handlers.
    const { getApps, initializeApp } = await import('firebase-admin/app');
    if (getApps().length === 0) {
      initializeApp({ projectId: process.env.GCP_PROJECT || 'awfl-us' });
    }
    const { getFirestore } = await import('firebase-admin/firestore');
    const actualCallbacks = createNativeCallbackEffects({
      db: getFirestore(), jobsOrigin,
    });
    callbackHandlers = {
      'callback.create': actualCallbacks['callback.create'],
      'callback.await': effect => actualCallbacks['callback.await']({
        ...effect,
        args: { ...effect.args,
          timeout: Math.min(effect.args.timeout, 60) },
      }),
    };
  }
  const handlers = {
    ...http,
    ...callbackHandlers,
    'log.write': createNativeLogEffectHandler({
      info: event => log('NATIVE_LOCAL_LOG ' + JSON.stringify(event).slice(0, 500)),
    }),
    ...(realStorage && {
      'storage.object_get': async effect => {
        try { return await realStorage(effect); }
        catch (error) {
          storageErrors.push(String(error?.message || error).slice(0, 220));
          throw error;
        }
      },
    }),
  };
  let result, error;
  const start = performance.now();
  try {
    const run = executionMode === 'memory'
      ? runNativeMemoryWorkflow : runNativeWorkflow;
    result = await run({
      store, releases, executionId,
      userId: identity.userId, projectId: identity.projectId,
      handlers, maxTransitions,
    });
  } catch (cause) { error = String(cause?.message || cause); }
  const state = await store.get(executionId);
  // Local development-only cleanup: workflow uses a session lock in the real
  // Jobs collection. A failed local process cannot finish the Scala unlock
  // step, so release only a lock owned by this exact test execution.
  if (localJobsUrl && state.status !== 'completed') {
    try {
      const response = await fetch(new URL('/firebase/locks/release', localJobsUrl), {
        method: 'POST', headers: {'content-type':'application/json',
          'x-user-id': identity.userId, 'x-project-id': identity.projectId},
        body: JSON.stringify({
          userId:identity.userId, projectId:identity.projectId,
          collection:'locks.Convo.Session',
          id: input.sessionId, owner:executionId,
        }),
        signal:AbortSignal.timeout(5000),
      });
      log('NATIVE_LOCAL_RELEASE_TEST_LOCK status=' + response.status);
    } catch (cleanupError) {
      log('NATIVE_LOCAL_RELEASE_TEST_LOCK failed=' +
        String(cleanupError?.message || cleanupError));
    }
  }
  return {
    executionId, executionMode, durationMs: Math.round(performance.now() - start),
    result, error, status: state.status, effectCount: state.effectCount,
    fixtureCalls: seen, missing, storageErrors, failedRequests,
    lanes: [...db._docs.entries()].filter(([key]) =>
      /^nativeWorkflowExecutions\/native_[^/]+$/.test(key))
      .map(([key, data]) => ({
        executionId: key.split('/').at(-1), status:data.status,
        effectCount:data.effectCount,
        pendingOperation:data.pendingEffect?.operation || null,
        error: data.errorJson ? String(data.errorJson).slice(0, 600) : null,
        resultType: data.resultJson ? 'present' : null,
      })),
    totalNativeExecutions: [...db._docs.keys()].filter(key =>
      /^nativeWorkflowExecutions\/native_/.test(key) &&
      !key.includes('/effects/')).length,
  };
}
