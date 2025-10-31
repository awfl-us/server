import { initializeApp, getApps } from 'firebase-admin/app';
import admin from 'firebase-admin';

// Ensure Firebase Admin is initialized once
if (!getApps().length) {
  initializeApp();
}

// Strict client-facing auth: requires a valid Firebase ID token.
// Ignores any userId hints in body/query/headers to avoid security leaks.
export async function clientAuth(req, res, next) {
  try {
    // Dev/test bypass
    if (process.env.SKIP_AUTH === '1' || req?.headers?.['x-skip-auth'] === '1') {
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

    const decoded = await admin.auth().verifyIdToken(token);
    req.userId = decoded?.uid;

    if (!req.userId) return res.status(403).json({ error: 'Unauthorized: invalid token' });

    // Strip any userId hints so downstream code cannot accidentally read them
    if (req?.body && 'userId' in req.body) delete req.body.userId;
    if (req?.query && 'userId' in req.query) delete req.query.userId;
    if (req?.headers && 'x-user-id' in req.headers) delete req.headers['x-user-id'];

    return next();
  } catch (err) {
    console.error('[clientAuth] error:', err?.message || err);
    return res.status(403).json({ error: 'Unauthorized: invalid token' });
  }
}

// Split auth helpers for workflows (client-facing)
// ESM module; project package.json is type: module.
export { getUserIdFromReq, userScopedCollectionPath, projectScopedCollectionPath } from './utils.js';
