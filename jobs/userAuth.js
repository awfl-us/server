import { allowSkipAuth } from '../workflows/utils.js';
// Split auth helpers for jobs/workflows execution (LB/OIDC-protected paths)
// Re-export from utils/userAuth.js to preserve behavior and avoid duplication.
// ESM module; project package.json is type: module.
export { getUserIdFromReq, projectScopedCollectionPath, allowSkipAuth } from '../workflows/utils.js';

// Workflows/LB-facing injector: trusts LB OIDC and accepts a plain userId
// from body/query/headers. Use ONLY under the /workflows (or internal) mounts.
export async function workflowsUserInject(req, res, next) {
  try {
    if (allowSkipAuth(req)) {
      req.userId = req.userId || 'dev-user';
      return next();
    }

    const hinted = req?.body?.userId || req?.query?.userId || req?.headers?.['x-user-id'];
    if (!hinted) return res.status(401).json({ error: 'Unauthorized: missing workflow userId' });

    req.userId = String(hinted);

    // Optionally strip hints so downstream code consistently uses req.userId
    if (req?.body && 'userId' in req.body) delete req.body.userId;
    if (req?.query && 'userId' in req.query) delete req.query.userId;
    if (req?.headers && 'x-user-id' in req.headers) delete req.headers['x-user-id'];

    return next();
  } catch (err) {
    console.error('[workflowsUserInject] error:', err?.message || err);
    return res.status(401).json({ error: 'Unauthorized' });
  }
}
