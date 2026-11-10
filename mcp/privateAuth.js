import { requireAwflApiKey } from '../workflows/apiKeys/verify.js';

// Reuse the exact AWFL MCP key scope, owner restriction and browser Origin
// policy for all private MCP endpoints.
export function privateMcpMiddleware(service, authenticate = requireAwflApiKey()) {
  return [authenticate, async (req, res, next) => {
    try {
      if (!await service.isOwner(req.userId)) {
        return res.status(403).json({ error: 'Private execution service: owner access required' });
      }
    } catch {
      return res.status(503).json({ error: 'Private owner verification unavailable' });
    }
    const origins = (process.env.MCP_ALLOWED_ORIGINS || 'https://awfl.us').split(',').map(x => x.trim());
    if (req.get('origin') && !origins.includes(req.get('origin'))) {
      return res.status(403).json({ error: 'Origin not allowed' });
    }
    next();
  }];
}
