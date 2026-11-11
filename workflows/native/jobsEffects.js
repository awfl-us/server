// Reuse the same Cloud Run IAM/OIDC trust boundary that Google Workflows
// uses to call /jobs. Generated Rust does not receive GCP credentials;
// Jobs requests originate from the trusted server using its own identity.
import { GoogleAuth } from 'google-auth-library';
import { createNativeLogEffectHandler } from './logEffects.js';

const METHODS = Object.freeze({
  'http.get': 'GET', 'http.post': 'POST',
  'http.patch': 'PATCH', 'http.delete': 'DELETE',
});

export function createJobsEffectHandlers({
  jobsOrigin, auth = new GoogleAuth(), timeoutMs = 30_000,
  logger = console,
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
  const handlers = { 'log.write': createNativeLogEffectHandler(logger) };
  for (const [operation, method] of Object.entries(METHODS)) {
    handlers[operation] = async ({ args, identity, idempotencyKey }) => {
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
            userId: identity.userId,
            projectId: identity.projectId,
          };
        } else {
          // For non-object bodies, existing Jobs middleware uses the
          // authenticated headers below instead of a body identity.
          data = args.body;
        }
      }
      const client = await auth.getIdTokenClient(base.origin);
      const response = await client.request({
        url: url.toString(), method,
        ...(Object.hasOwn(args, 'body') ? { data } : {}),
        headers: {
          'x-user-id': identity.userId,
          'x-project-id': identity.projectId,
          'x-awfl-idempotency-key': idempotencyKey,
        },
        timeout: timeoutMs,
        maxRedirects: 0,
      });
      if (!Number.isInteger(response?.status) ||
          response.status < 200 || response.status >= 300) {
        throw new Error('Jobs effect HTTP status not successful');
      }
      return { code: response.status, body: response.data };
    };
  }
  return Object.freeze(handlers);
}
