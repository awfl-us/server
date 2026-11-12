import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Versioned bearer tokens with a random lookup ID and a 256-bit secret.
// Only the SHA-256 digest is ever stored in Firestore.
const TOKEN_PATTERN = /^awfl_v1_([0-9a-f]{24})_([A-Za-z0-9_-]{43})$/;
// API keys work for AWFL's HTTP API and both MCP endpoints. Existing keys
// created for MCP remain valid after the shared-auth migration.
export const API_SCOPE = 'awfl:access';
export const MCP_SCOPE = 'mcp:invoke';
export const API_KEY_SCOPES = Object.freeze([API_SCOPE, MCP_SCOPE]);
export const API_KEY_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

export function generateApiKey() {
  const id = randomBytes(12).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const token = 'awfl_v1_' + id + '_' + secret;
  return { id, token, hash: hashApiKey(token), last4: token.slice(-4) };
}

export function parseApiKey(value) {
  if (typeof value !== 'string') return null;
  const match = TOKEN_PATTERN.exec(value);
  return match ? { id: match[1] } : null;
}

export function hashApiKey(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function matchesApiKeyHash(token, storedHash) {
  if (!parseApiKey(token) || typeof storedHash !== 'string' || !/^[0-9a-f]{64}$/.test(storedHash)) {
    return false;
  }
  const candidate = Buffer.from(hashApiKey(token), 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  return timingSafeEqual(candidate, expected);
}


export function isActiveApiKeyRecord(token, record, { requiredScope = null, now = Date.now() } = {}) {
  const parsed = parseApiKey(token);
  return Boolean(parsed && record &&
    record.id === parsed.id &&
    typeof record.userId === 'string' && record.userId &&
    matchesApiKeyHash(token, record.hash) &&
    Array.isArray(record.scopes) &&
    (requiredScope ? record.scopes.includes(requiredScope) :
      record.scopes.some(scope => API_KEY_SCOPES.includes(scope))) &&
    Number.isSafeInteger(record.expiresAt) && record.expiresAt > now);
}

// Explicit allowlist; never accidentally expose the token digest or owner UID.
export function apiKeyMetadata(record) {
  return {
    id: record.id,
    name: record.name,
    last4: record.last4,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    scopes: record.scopes,
  };
}
