import { MCP_RESOURCES, OAUTH_ISSUER, OAUTH_SCOPE } from '../workflows/oauth/core.js';
import { resolveAwflIdentity } from '../workflows/auth/identity.js';

function challenge(res, resource) {
  const suffix = resource === MCP_RESOURCES.agents ? '/mcp/agents' : '/mcp';
  res.set('WWW-Authenticate', `Bearer resource_metadata="${OAUTH_ISSUER}/.well-known/oauth-protected-resource${suffix}", scope="${OAUTH_SCOPE}", error="invalid_token", error_description="A valid AWFL OAuth token is required"`);
}

// Use the same Firebase/OAuth/API-key resolver as all other AWFL API routes.
export function requireMcpCredential(resource, resolveIdentity = resolveAwflIdentity) {
  return async (req, res, next) => {
    const token = /^Bearer (\S+)$/.exec(req.get('authorization') || '')?.[1] || '';
    if (token) {
      let identity;
      try { identity = await resolveIdentity(token); } catch {
        return res.status(503).json({ error: 'Authentication verification unavailable' });
      }
      if (!identity) {
        challenge(res, resource);
        return res.status(401).json({ error: 'Invalid or expired access token' });
      }
      req.userId = identity.userId;
      req.authMethod = identity.method;
      if (identity.keyId) req.apiKeyId = identity.keyId;
      if (identity.keyId) req.apiKeyScopes = identity.scopes;
      return next();
    }
    challenge(res, resource);
    return res.status(401).json({ error: 'Missing MCP access token' });
  };
}

// Reuse the exact owner restriction and browser Origin policy for all private MCPs.
export function privateMcpMiddleware(service, authenticate, resource = MCP_RESOURCES.terminal) {
  const verify = authenticate || requireMcpCredential(resource);
  return [verify, async (req, res, next) => {
    try {
      if (!await service.isOwner(req.userId)) {
        return res.status(403).json({ error: 'Private execution service: owner access required' });
      }
    } catch {
      return res.status(503).json({ error: 'Private owner verification unavailable' });
    }
    const origins = (process.env.MCP_ALLOWED_ORIGINS || 'https://awfl.us,https://chatgpt.com').split(',').map(x => x.trim());
    if (req.get('origin') && !origins.includes(req.get('origin'))) {
      return res.status(403).json({ error: 'Origin not allowed' });
    }
    next();
  }];
}
