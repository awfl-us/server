import admin from 'firebase-admin';
import { verifyAccessToken } from '../oauth/core.js';
import { parseApiKey } from '../apiKeys/core.js';
import { verifyAwflApiKey } from '../apiKeys/verify.js';

// Single identity resolver for the AWFL API and both MCP transports.
// Endpoint-specific owner and project checks still apply after authentication.
export async function resolveAwflIdentity(token, {
  verifyFirebaseToken = value => admin.auth().verifyIdToken(value),
  verifyApiKey = verifyAwflApiKey,
} = {}) {
  if (typeof token !== 'string' || !token || token.length > 16384) return null;
  if (token.startsWith('awfl_v1_')) {
    // An invalid/revoked API key must not fall through to Firebase auth.
    if (!parseApiKey(token)) return null;
    const key = await verifyApiKey(token);
    return key ? { userId: key.userId, method: 'api_key',
      keyId: key.keyId, scopes: key.scopes } : null;
  }
  const oauth = verifyAccessToken(token);
  if (oauth) return { userId: oauth.userId, method: 'oauth', clientId: oauth.clientId, scopes: oauth.scopes };
  try {
    const verified = await verifyFirebaseToken(token);
    return verified?.uid ? { userId: verified.uid, method: 'firebase' } : null;
  } catch {
    return null;
  }
}
