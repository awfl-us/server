# AWFL MCP: shared project consumer

The existing API service exposes MCP at `https://api.awfl.us/mcp`.
Authenticated MCP tools use an AWFL API key with the `mcp:invoke` scope;
the service remains restricted to the owner. **MCP is a client of AWFL's
existing project consumer, not a separate execution environment.**

## Single environment per project

The regular `POST /workflows/producer/start` route and MCP both use
`jobs/producer/start.js`:

- A project's normal `consumerLock` is the sole authority for startup.
- If a consumer already holds an unexpired lock, MCP attaches. This applies
  to the CLI and cloud consumer alike.
- Otherwise the shared startup helper acquires the same lock, creates the
  normal project workspace, and starts the ordinary GKE consumer Job
  (`consumer-...`). No `mcp-...` Job is created.
- The consumer continues to use the existing image, `awfl` namespace,
  service account, Firebase and GitHub App credentials.
- A default GKE consumer starts via the image's direct `['awfl', 'run']`
  entrypoint. Custom `AWFL_STARTUP_SH` continues to use the shell.

An MCP `workspace_id` is **an attachment handle**, not a new Kubernetes
runtime. `workspace_create` requires `project_id` (no arbitrary first
project) and optionally takes `session_id`; if omitted, it generates an
MCP-specific session identifier and returns it. Multiple attachments can
share one project consumer. `workspace_stop` detaches the MCP handle
without stopping or deleting the shared consumer. To actually stop the
project consumer, use the existing `/workflows/producer/stop` lifecycle.

## Requests and sessions

MCP adapts `run_command`, `read_file`, and `write_file` into the
same `RUN_COMMAND`, `READ_FILE`, and `UPDATE_FILE` tool calls emitted
by the normal web client. The relay event type is `message`, and the
payload carries the standard `tool_call` and `callback_id` fields.

The existing project-wide AWFL consumer executes these operations with
`handle_response()` unchanged. It posts the result to the usual
`/workflows/callbacks/:callbackId` endpoint using Firebase user auth.
A server-created callback record routes that result directly to the MCP
request in Firestore; it does not forward the result over another HTTP
connection. No second command implementation or SSE event handler is needed.

MCP calls wait up to 15s for the result. For longer commands, the API
returns `state=pending`; poll `request_result` using the same workspace
and request ID, without resubmitting the command. `run_command` reports
the standard AWFL `output`, `error` and `exitCode` fields.

Streaming and cancellation are deliberately not exposed: the ordinary
AWFL handler currently returns a completed result, not a persistent
execution ID. Any future streaming implementation should extend the
*shared* AWFL execution system rather than create a separate MCP runtime.

AWFL relay event delivery uses the same reconnect/replay semantics for
MCP and web-originated tool calls. Results are de-duplicated in Firestore,
but the standard consumer does not currently atomically claim events
before executing them. A replay before callback completion can therefore
repeat a command, just as with existing web tool calls. Do not assume
exactly-once shell side effects; use idempotent commands where needed.

## Safety and deployment

The caller must own the selected project. Per-request claim/result checks
also verify user, project, workspace, and bounded request numbers. The
consumer does not expose any MCP-specific callback bearer token. Because
the project environment has credentials, execute only trusted commands.

This is deliberately owner-only and not a multi-tenant arbitrary shell
service. MCP does not install any separate GKE infrastructure. Any changes
to the Python consumer are pinned through `AWFL_CLI_REF` in the existing
deployment workflow. Do not deploy a server that emits MCP project events
until the corresponding updated Python CLI image has been deployed.

Tests: `node --test mcp/tests/*.test.js` (server) and
`python -m unittest discover -s tests -v` (CLI).
