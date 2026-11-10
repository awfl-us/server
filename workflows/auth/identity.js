import admin from 'firebase-admin';
import { verifyAccessToken } from '../oauth/core.js';

// Single identity resolver for the AWFL API and its two MCP transports.
// OAuth access tokens and existing Firebase ID tokens resolve to the same uid.
// Legacy AWFL API keys remain supported only where explicitly enabled (MCP).
export async function resolveAwflIdentity(token, {
  verifyFirebaseToken = value => admin.auth().verifyIdToken(value),
} = {}) {
  if (typeof token !== 'string' || !token || token.length > 16384) return null;
  const oauth = verifyAccessToken(token);
  if (oauth) return { userId: oauth.userId, method: 'oauth', clientId: oauth.clientId, scopes: oauth.scopes };
  try {
    const verified = await verifyFirebaseToken(token);
    return verified?.uid ? { userId: verified.uid, method: 'firebase' } : null;
  } catch {
    return null;
  }
}
