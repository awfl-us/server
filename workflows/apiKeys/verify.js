import { getFirestore } from 'firebase-admin/firestore';
import { MCP_SCOPE, isActiveApiKeyRecord, parseApiKey } from './core.js';

// Shared API and MCP verifier. Read Firestore on every request so revocation,
// expiration and scope changes take effect without process-local caches.
export async function verifyAwflApiKey(token, { db = getFirestore(), requiredScope = null, now = Date.now() } = {}) {
  const parsed = parseApiKey(token);
  if (!parsed) return null;

  const snap = await db.collection('apiKeys').doc(parsed.id).get();
  if (!snap.exists) return null;

  const data = snap.data() || {};
  if (!isActiveApiKeyRecord(token, data, { requiredScope, now })) return null;

  return { userId: data.userId, keyId: parsed.id, scopes: [...data.scopes] };
}

// Retained for standalone callers; normal HTTP API and MCP routes now share
// resolveAwflIdentity.
export function requireAwflApiKey(requiredScope = MCP_SCOPE) {
  return async (req, res, next) => {
    const authorization = req.get('authorization') || '';
    const match = /^Bearer (\S+)$/.exec(authorization);
    if (!match) return res.status(401).json({ error: 'Missing API key' });
    try {
      const identity = await verifyAwflApiKey(match[1], { requiredScope });
      if (!identity) return res.status(401).json({ error: 'Invalid or expired API key' });
      req.userId = identity.userId;
      req.apiKeyId = identity.keyId;
      req.apiKeyScopes = identity.scopes;
      return next();
    } catch (error) {
      // Never log Authorization, key material or request bodies.
      console.error('[api-keys] verification error', error?.name || 'Error');
      return res.status(503).json({ error: 'API key verification unavailable' });
    }
  };
}
