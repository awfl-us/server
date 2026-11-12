import { initializeApp, getApps } from 'firebase-admin/app';
import admin from 'firebase-admin';
import { allowSkipAuth } from './utils.js';
import { resolveAwflIdentity } from './auth/identity.js';

// Ensure Firebase Admin is initialized once
if (!getApps().length) {
  initializeApp();
}

// All AWFL API routes accept Firebase ID tokens, OAuth access tokens and AWFL
// API keys. Each maps to the same userId for existing policy enforcement.
// Ignores any userId hints in body/query/headers to avoid security leaks.
export function createClientAuth(resolveIdentity = resolveAwflIdentity) {
  return async function clientAuth(req, res, next) {
  try {
    // Dev/test bypass guarded by local dev detection
    if (allowSkipAuth(req)) {
      req.userId = req.headers['x-user-id'] || 'dev-user';
      // Strip any userId hints so downstream code cannot accidentally read them
      if (req?.body && 'userId' in req.body) delete req.body.userId;
      if (req?.query && 'userId' in req.query) delete req.query.userId;
      if (req?.headers && 'x-user-id' in req.headers) delete req.headers['x-user-id'];
      return next();
    }

    let token = req?.body?.userAuthToken;
    if (!token) {
      const authHeader = req?.headers?.authorization || req?.headers?.Authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring('Bearer '.length);
      }
    }

    if (!token) {
      return res.status(401).json({ error: 'Unauthorized: missing token' });
    }

    const identity = await resolveIdentity(token);
    req.userId = identity?.userId;
    req.authMethod = identity?.method;
    if (identity?.keyId) req.apiKeyId = identity.keyId;
    if (identity?.keyId) req.apiKeyScopes = identity.scopes;

    if (!req.userId) return res.status(403).json({ error: 'Unauthorized: invalid token' });

    // Strip any userId hints so downstream code cannot accidentally read them
    if (req?.body && 'userId' in req.body) delete req.body.userId;
    if (req?.query && 'userId' in req.query) delete req.query.userId;
    if (req?.headers && 'x-user-id' in req.headers) delete req.headers['x-user-id'];

    return next();
  } catch (err) {
    // A Firestore/key-verification outage is not evidence of a bad token.
    // Fail closed, but distinguish temporary unavailability from a revoked key.
    console.error('[clientAuth] credential verification unavailable:', err?.name || 'Error');
    return res.status(503).json({ error: 'Authentication verification unavailable' });
  }
  };
}

export const clientAuth = createClientAuth();

// Split auth helpers for workflows (client-facing)
// ESM module; project package.json is type: module.
export { getUserIdFromReq, userScopedCollectionPath, projectScopedCollectionPath } from './utils.js';
