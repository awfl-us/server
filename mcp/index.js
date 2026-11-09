import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireAwflApiKey } from '../workflows/apiKeys/verify.js';
import { tools } from './tools.js';
import { ENVIRONMENT_INSTRUCTIONS, ENVIRONMENT_GUIDE, ENVIRONMENT_GUIDE_URI } from './environment.js';

export function createMcpRouter(service, authenticate = requireAwflApiKey()) {
  const router = express.Router();
  router.use(authenticate);
  router.use(async (req, res, next) => {
    try {
      if (!await service.isOwner(req.userId)) return res.status(403).json({ error: 'Private execution service: owner access required' });
    } catch {
      return res.status(503).json({ error: 'Private owner verification unavailable' });
    }
    // Server-to-server clients omit Origin. Browsers must match an explicit allowlist.
    const origins = (process.env.MCP_ALLOWED_ORIGINS || 'https://awfl.us').split(',').map(x => x.trim());
    if (req.get('origin') && !origins.includes(req.get('origin'))) return res.status(403).json({ error: 'Origin not allowed' });
    next();
  });
  router.post('/', async (req, res) => {
    // A new SDK server/transport for every HTTP request prevents cross-user/session leakage.
    const server = new McpServer(
      { name: 'awfl-cloud-execution', version: '1.1.0' },
      { instructions: ENVIRONMENT_INSTRUCTIONS },
    );
    // MCP resources are discoverable by clients that support resources/list.
    // No secrets are embedded; live credential status comes from environment_status.
    server.registerResource('awfl-environment-guide', ENVIRONMENT_GUIDE_URI,
      { description: 'AWFL project consumer, credentials, refresh and tool usage', mimeType: 'text/markdown' },
      async uri => ({
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: ENVIRONMENT_GUIDE }],
      }));
    for (const [name, definition] of Object.entries(tools)) {
      server.registerTool(name, { description: definition.description, inputSchema: definition.schema,
        annotations: { readOnlyHint: Boolean(definition.readOnly), destructiveHint: !definition.readOnly,
          idempotentHint: Boolean(definition.readOnly), openWorldHint: true } }, async args => {
        try {
          const result = await service.invoke(req.userId, name, args);
          return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: Boolean(result.error && (typeof result.error === 'object' || result.state === 'failed')) };
        } catch (error) {
          // Only known public errors cross the trust boundary. Never emit SDK/GCP error bodies.
          return { isError: true, content: [{ type: 'text', text: error.publicMessage || 'Execution service unavailable; retry or inspect deployment health' }] };
        }
      });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ error: 'MCP transport unavailable' });
    }
  });
  router.all('/', (_req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Stateless Streamable HTTP: use POST; poll request_result for pending commands' }));
  return router;
}
