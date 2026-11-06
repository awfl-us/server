# AWFL MCP: shared project consumer

The existing API service exposes MCP at \`https://api.awfl.us/mcp\`.
Authenticated MCP tools use an AWFL API key with the \`mcp:invoke\` scope;
the service remains restricted to the owner. **MCP is a client of AWFL's
existing project consumer, not a separate execution environment.**

## Single environment per project

The regular \`POST /workflows/producer/start\` route and MCP both use
\`jobs/producer/start.js\`:

- A project's normal \`consumerLock\` is the sole authority for startup.
- If a consumer already holds an unexpired lock, MCP attaches. This applies
  to the CLI and cloud consumer alike.
- Otherwise the shared startup helper acquires the same lock, creates the
  normal project workspace, and starts the ordinary GKE consumer Job
  (\`consumer-...\`). No \`mcp-...\` Job is created.
- The consumer continues to use the existing image, \`awfl\` namespace,
  service account, Firebase and GitHub App credentials.
- A default GKE consumer starts via the image's direct \`['awfl', 'run']\`
  entrypoint. Custom \`AWFL_STARTUP_SH\` continues to use the shell.

An MCP \`workspace_id\` is **an attachment handle**, not a new Kubernetes
runtime. \`workspace_create\` requires \`project_id\` (no arbitrary first
project) and optionally takes \`session_id\`; if omitted, it generates an
MCP-specific session identifier and returns it. Multiple attachments can
share one project consumer. \`workspace_stop\` detaches the MCP handle
without stopping or deleting the shared consumer. To actually stop the
project consumer, use the existing \`/workflows/producer/stop\` lifecycle.

## Requests and sessions

The API writes an MCP tool invocation to the project's existing
\`relayEvents\` stream as an \`mcp_tool_call\` with a \`sessionId\`.
The same project-scoped AWFL CLI consumer that processes normal workflow
events receives the invocation. Its shared \`Runtime\` executes commands,
reads/writes files, and tracks command output and cancellation.

Before executing, the consumer atomically claims the MCP request using
\`POST /workflows/mcp-tools/:workspaceId/:requestId/claim\`. Replayed SSE
events cannot claim an already-started request and cannot repeat side
effects. After execution it reports the result via the matching
\`/result\` endpoint, which stores the result for MCP polling and posts
a short \`mcp_tool_result\` event to the same project/session stream.
The endpoints use ordinary Firebase authentication and the current
\`x-project-id\` header, as do regular AWFL callbacks.

The request/result records in \`mcpWorkspaces\` are correlation metadata,
not a second work queue or a second SSE transport. Commands can return
\`state=pending\` after 15s; call \`request_result\` without resubmitting
the side effect. Long commands return \`execution_id\`; retrieve output
through \`command_output\`.

Session event history is separate from any application-specific GCS/Yoj
conversation index; clients may need to use the existing session/message
ingestion workflow for UI visibility beyond the relay's TTL.

## Safety and deployment

The caller must own the selected project. Per-request claim/result checks
also verify user, project, workspace, and bounded request numbers. The
consumer does not expose any MCP-specific callback bearer token. Because
the project environment has credentials, execute only trusted commands.

This is deliberately owner-only and not a multi-tenant arbitrary shell
service. MCP does not install any separate GKE infrastructure. Any changes
to the Python consumer are pinned through \`AWFL_CLI_REF\` in the existing
deployment workflow. Do not deploy a server that emits MCP project events
until the corresponding updated Python CLI image has been deployed.

Tests: \`node --test mcp/tests/*.test.js\` (server) and
\`python -m unittest discover -s tests -v\` (CLI).
