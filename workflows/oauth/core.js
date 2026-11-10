import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// OAuth is another AWFL API authentication method, not an MCP identity.
export const OAUTH_ISSUER = 'https://api.awfl.us';
export const API_RESOURCE = OAUTH_ISSUER;
export const MCP_RESOURCES = Object.freeze({
  terminal: OAUTH_ISSUER + '/mcp',
  agents: OAUTH_ISSUER + '/mcp/agents',
});
export const normalizeResource = resource =>
  resource === API_RESOURCE || Object.values(MCP_RESOURCES).includes(resource)
    ? API_RESOURCE : null;
export const OAUTH_SCOPE = 'awfl:access';
export const ACCESS_TTL_SECONDS = 15 * 60;
export const CODE_TTL_MS = 5 * 60 * 1000;
export const CONSENT_TTL_MS = 10 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const randomToken = () => randomBytes(32).toString('base64url');
export const hashToken = token => createHash('sha256').update(token).digest('hex');
export const pkceChallenge = verifier => createHash('sha256').update(verifier).digest('base64url');
const b64 = input => Buffer.from(JSON.stringify(input)).toString('base64url');

// ENCRYPTION_SECRET_KEY is already provisioned through GCP Secret Manager on the API.
// Domain separation ensures OAuth tokens cannot be used as application ciphertext keys.
function signingKey(secret = process.env.ENCRYPTION_SECRET_KEY) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('OAuth token signing secret unavailable');
  }
  return createHmac('sha256', secret).update('awfl/mcp/oauth-access/v1').digest();
}
export function mintAccessToken({ userId, resource = API_RESOURCE, clientId, scopes = OAUTH_SCOPE, now = Date.now(), secret }) {
  if (!normalizeResource(resource)) throw new Error('Invalid OAuth resource');
  const header = b64({ alg: 'HS256', typ: 'at+jwt' });
  const payload = b64({
    iss: OAUTH_ISSUER, sub: userId, aud: API_RESOURCE, client_id: clientId,
    scope: scopes, iat: Math.floor(now / 1000), nbf: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + ACCESS_TTL_SECONDS, jti: randomToken(),
  });
  const message = header + '.' + payload;
  const signature = createHmac('sha256', signingKey(secret)).update(message).digest('base64url');
  return message + '.' + signature;
}
export function verifyAccessToken(token, { now = Date.now(), secret } = {}) {
  if (typeof token !== 'string' || token.length > 8192) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const [header, body, mac] = parts;
    const actual = Buffer.from(mac, 'base64url');
    const expected = createHmac('sha256', signingKey(secret)).update(header + '.' + body).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const meta = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const seconds = Math.floor(now / 1000);
    if (meta.alg !== 'HS256' || meta.typ !== 'at+jwt' ||
      claims.iss !== OAUTH_ISSUER || claims.aud !== API_RESOURCE ||
      !claims.sub || !claims.client_id || !Number.isInteger(claims.exp) ||
      !Number.isInteger(claims.nbf) || claims.nbf > seconds ||
      claims.exp <= seconds || claims.iat > seconds ||
      !String(claims.scope || '').split(' ').includes(OAUTH_SCOPE)) return null;
    return { userId: claims.sub, clientId: claims.client_id, scopes: claims.scope.split(' ') };
  } catch {
    return null;
  }
}
export function isValidChatGptRedirect(input) {
  if (typeof input !== 'string') return false;
  try {
    const uri = new URL(input);
    return uri.origin === 'https://chatgpt.com' &&
      !uri.search && !uri.hash &&
      (uri.pathname === '/connector_platform_oauth_redirect' ||
        /^\/connector\/oauth\/[A-Za-z0-9_-]{8,128}$/.test(uri.pathname));
  } catch {
    return false;
  }
}
export function callbackUrl(redirect, params) {
  const url = new URL(redirect);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  url.searchParams.set('iss', OAUTH_ISSUER);
  return url.toString();
}
