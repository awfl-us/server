// A policy-constrained adapter from canonical AWFL http.* effects to a
// caller-supplied transport. No default fetch: the production transport
// must independently enforce DNS/IP pinning and network egress policy.
import { isIP } from 'node:net';
import { NativeConfirmedHttpFailure } from './effectErrors.js';

const METHODS = {
  'http.get': 'GET',
  'http.post': 'POST',
  'http.patch': 'PATCH',
  'http.delete': 'DELETE',
};
const MAX_REQUEST = 128 * 1024;
const MAX_RESPONSE = 128 * 1024;
const MAX_TIMEOUT = 30_000;

const bodyBytes = value => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized) > MAX_REQUEST) {
    throw new Error('native HTTP request body too large or invalid');
  }
  return serialized;
};

function httpsOrigin(raw) {
  if (typeof raw !== 'string') throw new Error('native HTTP target origin required');
  let url;
  try { url = new URL(raw); } catch { throw new Error('invalid native HTTP origin'); }
  if (url.protocol !== 'https:' || url.username || url.password ||
      url.hash || url.search || url.pathname !== '/' ||
      url.port || isIP(url.hostname) ||
      !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(url.hostname) ||
      url.hostname === 'localhost' || url.hostname.endsWith('.local') ||
      url.hostname.endsWith('.internal')) {
    throw new Error('native HTTP target must be a public HTTPS DNS origin');
  }
  return url.origin;
}

function validateTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('native HTTP targets must be explicitly configured');
  }
  const seen = new Set();
  return targets.map(target => {
    if (!target || typeof target !== 'object') {
      throw new Error('invalid native HTTP target policy');
    }
    const origin = httpsOrigin(target.origin);
    if (seen.has(origin)) throw new Error('duplicate native HTTP target');
    seen.add(origin);
    if (!Array.isArray(target.methods) || target.methods.length === 0 ||
        !target.methods.every(method => Object.values(METHODS).includes(method)) ||
        new Set(target.methods).size !== target.methods.length ||
        !Array.isArray(target.pathPrefixes) || target.pathPrefixes.length === 0 ||
        !target.pathPrefixes.every(path => typeof path === 'string' &&
          path.startsWith('/') && !path.startsWith('//') &&
          !path.includes('?') && !path.includes('#') && !path.includes('..')) ||
        !['bearer', 'none'].includes(target.authentication)) {
      throw new Error('invalid native HTTP target policy');
    }
    return Object.freeze({
      origin,
      methods: new Set(target.methods),
      pathPrefixes: Object.freeze([...target.pathPrefixes]),
      authentication: target.authentication,
    });
  });
}

function requestUrl(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) ||
      typeof args.url !== 'string' ||
      Object.keys(args).some(key => !['url', 'body'].includes(key))) {
    throw new Error('native HTTP arguments must contain only url and optional body');
  }
  let url;
  try { url = new URL(args.url); } catch { throw new Error('invalid native HTTP URL'); }
  if (url.protocol !== 'https:' || url.username || url.password ||
      url.hash || url.port || isIP(url.hostname) ||
      url.pathname.includes('%')) {
    // Avoid multiple path-decoding interpretations by upstream proxies:
    // encoded slashes, backslashes and dot segments cannot bypass prefixes.
    throw new Error('native HTTP URL must be canonical HTTPS without credentials');
  }
  return url;
}

/** Build handlers for NativeEffectDispatcher from trusted server policy.
  *
  * transport.sendRequest must implement restricted DNS/IP routing, redirect
  * rejection, response byte caps and timeouts. No live network transport is
  * provided here; the caller must inject a separately audited implementation.
  */
export function createNativeHttpEffectHandlers({
  targets, transport, credentialProvider, timeoutMs = 10_000,
}) {
  if (typeof transport?.sendRequest !== 'function') {
    throw new Error('restricted native HTTP transport required');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT) {
    throw new Error('invalid native HTTP timeout');
  }
  const policies = validateTargets(targets);
  if (policies.some(policy => policy.authentication === 'bearer') &&
      typeof credentialProvider !== 'function') {
    throw new Error('trusted native credential provider required');
  }
  const handlers = {};
  for (const [operation, method] of Object.entries(METHODS)) {
    handlers[operation] = async ({ args, idempotencyKey, identity }) => {
      if (typeof identity?.userId !== 'string' || !identity.userId ||
          typeof identity?.projectId !== 'string' || !identity.projectId ||
          typeof idempotencyKey !== 'string' ||
          !/^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(idempotencyKey)) {
        throw new Error('trusted native HTTP identity and idempotency key required');
      }
      const url = requestUrl(args);
      const policy = policies.find(p => p.origin === url.origin);
      if (!policy || !policy.methods.has(method) ||
          !policy.pathPrefixes.some(prefix => url.pathname.startsWith(prefix))) {
        throw new Error('native HTTP target or method not permitted');
      }
      if ((method === 'GET' || method === 'DELETE') &&
          Object.hasOwn(args, 'body')) {
        throw new Error('native HTTP method does not permit a body');
      }
      const body = Object.hasOwn(args, 'body') ? bodyBytes(args.body) : undefined;
      const headers = {
        'accept': 'application/json',
        'x-awfl-idempotency-key': idempotencyKey,
      };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (policy.authentication === 'bearer') {
        // Tokens come only from the trusted server context, never from
        // workflow-provided headers, URL parameters, or compiled code.
        const token = await credentialProvider({
          origin: policy.origin, method, userId: identity.userId,
          projectId: identity.projectId,
        });
        if (typeof token !== 'string' || !token || token.includes('\r') ||
            token.includes('\n') || token.length > 16_384) {
          throw new Error('invalid native HTTP server credential');
        }
        headers.authorization = 'Bearer ' + token;
      }
      const response = await transport.sendRequest({
        url: url.toString(), method, body, headers,
        timeoutMs, redirect: 'error', credentials: 'omit',
        maxResponseBytes: MAX_RESPONSE,
      });
      if (!response || !Number.isSafeInteger(response.status)) {
        throw new Error('native HTTP response rejected; error or redirect');
      }
      if (response.status >= 400 && response.status <= 599) {
        // A received response is definitive; no blind retry or guesswork.
        // The dispatcher may route it into a compiled Try handler.
        throw new NativeConfirmedHttpFailure(response.status);
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error('native HTTP response rejected; error or redirect');
      }
      const content = response.body;
      const serialized = JSON.stringify(content);
      if (serialized === undefined || Buffer.byteLength(serialized) > MAX_RESPONSE) {
        throw new Error('native HTTP response body too large or invalid');
      }
      return { code: response.status, body: content };
    };
  }
  return Object.freeze(handlers);
}
