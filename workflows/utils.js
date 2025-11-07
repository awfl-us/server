import { initializeApp, getApps } from 'firebase-admin/app';
import admin from 'firebase-admin';

// Ensure Firebase Admin is initialized once (safe in multi-import scenarios)
if (!getApps().length) {
  initializeApp();
}

// Clean, minimal skip-auth gate:
// - Requires server env ALLOW_SKIP_AUTH=1
// - Requires request header x-skip-auth=1
// - Disabled when NODE_ENV=production (belt-and-suspenders)
export function allowSkipAuth(req) {
  const enabled = process.env.ALLOW_SKIP_AUTH === '1';
  const inProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';
  const header = req?.headers?.['x-skip-auth'] === '1';
  return enabled && !inProd && header;
}

// Simplified helper: returns req.userId when already set, or verifies token if present.
// Does NOT accept plain userId. Intended for transitional use only.
export async function getUserIdFromReq(req) {
  try {
    if (req?.userId) return String(req.userId);

    if (allowSkipAuth(req)) {
      return 'dev-user';
    }

    let token = req?.body?.userAuthToken;
    if (!token) {
      const authHeader = req?.headers?.authorization || req?.headers?.Authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring('Bearer '.length);
      }
    }

    if (!token) return null;

    const decoded = await admin.auth().verifyIdToken(token);
    return decoded?.uid || null;
  } catch (err) {
    console.error('[getUserIdFromReq] error:', err?.message || err);
    return null;
  }
}

// Helper to prefix any collection path under the user document
export function userScopedCollectionPath(userId, collectionPath) {
  if (!userId) throw new Error('userId is required for user-scoped collection path');
  const clean = String(collectionPath || '').replace(/^\/+/, '');
  return `users/${userId}/${clean}`;
}

export function projectScopedCollectionPath(userId, projectId, collectionPath) {
  if (!projectId) throw new Error('projectId is required for project-scoped collection path');
  return userScopedCollectionPath(userId, `projects/${projectId}/${collectionPath}`);
}
