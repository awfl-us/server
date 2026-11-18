// Reuse the same Cloud Run IAM/OIDC trust boundary that Google Workflows
// uses to call /jobs. Generated Rust does not receive GCP credentials;
// Jobs requests originate from the trusted server using its own identity.
import { GoogleAuth } from 'google-auth-library';
import { context, propagation } from '@opentelemetry/api';
import { createNativeLogEffectHandler } from './logEffects.js';
import { createNativeStorageEffectHandler } from './storageEffects.js';
import { createNativeCallbackEffects } from './callbackEffects.js';
import { nativeProjectHeader, resolveNativeProjectIdentity } from './projectScope.js';

const METHODS = Object.freeze({
  'http.get': 'GET', 'http.post': 'POST',
  'http.patch': 'PATCH', 'http.delete': 'DELETE',
});

// A nested workflow may execute in a temporary project but must deliver its
// response to a callback that was registered in the parent project. Resolve
// that callback's authoritative scope, rather than trusting the nested
// workflow's default Env project header. Never redirect an arbitrary URL:
// only a registered native callback belonging to this same execution/user.
async function registeredCallbackProject({
  method, url, identity, idempotencyKey, callbackDb, callbackStorage,
  trustedCallbackAncestors = [],
}) {
  const match = method === 'POST' &&
    /^\/callbacks\/(n[a-f0-9]{32})$/.exec(url.pathname);
  if (!match || (!callbackDb && !callbackStorage)) return undefined;
  const path = `users/${identity.userId}/callbacks/${match[1]}`;
  const snap = callbackStorage
    ? await callbackStorage.get(path) : await callbackDb.doc(path).get();
  const saved = callbackStorage ? snap?.data : snap?.data();
  if (!saved || saved.kind !== 'native_workflow') return undefined;
  const currentExecutionId = idempotencyKey?.split(':')[0];
  const trustedAncestors = Array.isArray(trustedCallbackAncestors) &&
    trustedCallbackAncestors.length <= 16 &&
    trustedCallbackAncestors.every(id => /^native_[a-f0-9]{32}$/.test(id))
      ? trustedCallbackAncestors : [];
  if (saved.created_by !== identity.userId ||
      (saved.native_execution_id !== currentExecutionId &&
       !trustedAncestors.includes(saved.native_execution_id))) {
    throw new Error('native callback does not belong to authenticated execution');
  }
  return saved.native_project_id;
}

export function createJobsEffectHandlers({
  jobsOrigin, auth = new GoogleAuth(), timeoutMs = 30_000,
  logger = console,
  profiler = null, storage = null, callbackDb = null, callbackStorage = null,
  getProjectStorage,
}) {
  let base;
  try { base = new URL(jobsOrigin); } catch { /* validate below */ }
  if (!base || base.protocol !== 'https:' || base.pathname !== '/' ||
      base.username || base.password || base.hash || base.search ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error('trusted Jobs service HTTPS origin required');
  }
  if (typeof auth?.getIdTokenClient !== 'function') {
    throw new Error('Jobs IAM identity provider required');
  }
  const handlers = {
    'log.write': createNativeLogEffectHandler(logger),
    ...(storage && { 'storage.object_get': createNativeStorageEffectHandler({ storage }) }),
    ...((callbackStorage || callbackDb) && createNativeCallbackEffects({
      db: callbackDb, storage: callbackStorage, jobsOrigin: base.origin })),
  };
  for (const [operation, method] of Object.entries(METHODS)) {
    handlers[operation] = async ({
      args, identity, idempotencyKey, trustedCallbackAncestors = [],
    }) => {
      if (!args || typeof args !== 'object' || Array.isArray(args) ||
          typeof args.url !== 'string' ||
          typeof identity?.userId !== 'string' || !identity.userId ||
          typeof identity?.projectId !== 'string' || !identity.projectId) {
        throw new Error('Jobs effect requires authenticated identity and URL');
      }
      let url;
      try { url = new URL(args.url); } catch { throw new Error('invalid Jobs effect URL'); }
      if (url.origin !== base.origin || url.username || url.password ||
          url.hash || !url.pathname.startsWith('/') ||
          url.pathname.startsWith('//')) {
        throw new Error('native effect target must be the IAM-protected Jobs service');
      }
      // Caller-controlled auth headers, URLs, or body.userId never override
      // authenticated workflow context; only the server provides it.
      if (args.auth != null && args.auth.type !== 'OIDC') {
        throw new Error('native Jobs effect requires OIDC authentication');
      }
      // A nested evaluation can intentionally operate in a different project
      // owned by the *same* authenticated user. Check ownership against the
      // provider-neutral project store before forming the trusted Jobs request.
      const callbackProject = await registeredCallbackProject({
        method, url, identity, idempotencyKey, callbackDb, callbackStorage,
        trustedCallbackAncestors,
      });
      const target = await resolveNativeProjectIdentity(identity, {
        projectId: callbackProject ?? nativeProjectHeader(args.headers),
        getStorage: getProjectStorage,
      });
      // jobs/workflowsUserInject prioritizes body.userId over x-user-id, and
      // projectIdMiddleware likewise reads the body. A DSL-authored body must
      // never be able to impersonate another user or project, even though the
      // HTTP request itself is authenticated with the server's GCP identity.
      // The execution's authenticated scope always wins in both locations.
      let data;
      if (Object.hasOwn(args, 'body')) {
        if (args.body && typeof args.body === 'object' &&
            !Array.isArray(args.body) &&
            Object.getPrototypeOf(args.body) === Object.prototype) {
          data = {
            ...args.body,
            userId: target.userId,
            projectId: target.projectId,
          };
        } else {
          // For non-object bodies, existing Jobs middleware uses the
          // authenticated headers below instead of a body identity.
          data = args.body;
        }
      }
      const acquireClient = () => auth.getIdTokenClient(base.origin);
      const client = profiler ? await profiler.measure('oidc.client', acquireClient)
        : await acquireClient();
      const headers = {
        'x-user-id': target.userId,
        'x-project-id': target.projectId,
        'x-awfl-idempotency-key': idempotencyKey,
      };
      propagation.inject(context.active(), headers);
      const request = () => client.request({
        url: url.toString(), method,
        ...(Object.hasOwn(args, 'body') ? { data } : {}),
        headers,
        timeout: timeoutMs,
        maxRedirects: 0,
      });
      const response = profiler ? await profiler.measure('oidc.http_request', request)
        : await request();
      if (!Number.isInteger(response?.status) ||
          response.status < 200 || response.status >= 300) {
        throw new Error('Jobs effect HTTP status not successful');
      }
      return { code: response.status, body: response.data };
    };
  }
  return Object.freeze(handlers);
}
