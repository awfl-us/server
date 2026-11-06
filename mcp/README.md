# AWFL MCP cloud execution

The existing AWFL API service exposes Streamable HTTP MCP at
`https://api.awfl.us/mcp` (POST). Requests require
`Authorization: Bearer <AWFL API key>`, verified against Firestore on every
request by `requireAwflApiKey()`. Firebase web authorization is separate.

The endpoint is initially private to one AWFL account. Configure
`MCP_OWNER_UID` with the account's Firebase UID to pin ownership. If unset,
the API's existing Firestore access identifies the sole owner of active
`mcp:invoke` keys at request time. No owner or multiple owners fails closed.
The GitHub deployer does not need Firestore data permissions.

## Reuse existing AWFL cloud execution

**No new cloud service, cluster, namespace, job controller, IAM role, or
execution image.** The MCP control plane runs in the existing Cloud Run API
service. `jobs/producer/mcpRunner.js` is a small adapter around the existing
`jobs/producer/gke.js` functions `runK8sJob` and `deleteK8sJob`.

It uses the existing:
- GKE cluster `awfl-gke`
- namespace `K8S_NAMESPACE` (default `awfl`)
- Kubernetes service account `CONSUMER_KSA_NAME` (default `consumer`)
- `CONSUMER_K8S_IMAGE` built from `cloud/sse-consumer/Dockerfile`
- Python `awfl run` consumer and AWFL tool-call dispatch
- Per-user Firebase token minting and project-specific GitHub credential resolution

The regular AWFL consumer image now includes Python, Git, the GitHub CLI,
Node.js, Playwright and Chromium; the CI pipeline pins the Python CLI revision.
The default GKE producer path runs the baked-in AWFL CLI rather than replacing
it with an older PyPI version at startup.

`workspace_create` takes an optional `project_id`. When supplied, the
project must belong to the authenticated user, and its existing GitHub
integration credentials are used. Without it, the first existing user project
is selected if available; otherwise the global GitHub token fallback is used.
The consumer also receives the same Firebase tokens as ordinary AWFL cloud
consumers. In MCP execution mode, child shell commands inherit the consumer's
credentials (including GitHub and Firebase) but not `AWFL_EXECUTION_*`
capabilities. Do not run untrusted shell commands.

The MCP request/result bridge (`mcp/consumer.js`, `mcp/service.js`) remains
because it correlates each tool invocation with an output and supports
retrieving pending results without replaying commands. It reuses the existing
AWFL SSE framing, Python parser, callback sender and tool-handler envelope.
Workspace metadata and the command queue are stored in Firestore and scoped
to the authenticated owner.

## MCP tools

`environment_status`, `workspace_create`, `run_command`,
`command_output`, `command_cancel`, `read_file`, `write_file`,
`workspace_stop`, `request_result`.

A workspace is one consumer Job lasting up to one hour. Repeated commands
reuse `/workspace`. The Python runtime enforces four simultaneous commands,
128 executions per workspace, per-command timeout/output limits, and bounded
file operations. The existing Kubernetes Job launcher now accepts an optional
active deadline to enforce the one-hour limit.

If a tool invocation returns `state=pending`, call `request_result`
using its `request_id`; do not repeat a mutating call. Use
`command_output` with `next_cursor` to poll stdout/stderr. Stopping a
workspace invalidates its callback capability before stopping the existing
Kubernetes Job.

## Security

The service remains **private/single-user**, not an untrusted multi-tenant
execution platform. Each request verifies the API key and user owner, and each
workspace verifies ownership. Bearer keys are never stored in plaintext.
The bridge capability is stored hashed in Firestore, expires with the
workspace, and is removed from shell subprocess environments.

This implementation deliberately retains the existing consumer's Firebase,
GitHub and cloud credential access, as requested. Commands are granted those
credentials, so treat MCP command execution as trusted administrative access
to the user's AWFL resources; the previous extra locked-down execution
namespace and credential restrictions no longer apply.

## Deployment and testing

Merges to `main` trigger the existing
`.github/workflows/deploy-cloud-run.yml`. It builds the existing consumer
image with the pinned AWFL CLI revision, deploys the existing API and Jobs
services, and verifies that `/mcp` rejects anonymous access (HTTP 401).

This workflow **does not** configure Kubernetes or read Firestore as the
GitHub deployer. Those earlier additions blocked API deployment due to
missing `container.clusters.get` and Firestore permissions, and were removed.

Unit tests: `node --test mcp/tests/*.test.js`.
Python execution tests: `python -m unittest discover -s tests -v` in
`awfl-us/cli`. Live authenticated execution can be verified separately with
`node scripts/mcp-smoke.js` under a trusted administrator identity with
Firestore data access. The script creates and deletes temporary test keys;
do not put your personal AWFL API key into GitHub Actions or logs.

The public endpoint may return 401 even when the GKE runtime is unavailable;
an authenticated `workspace_create`, `run_command`, Chromium launch,
and cleanup must pass before claiming end-to-end completion.

## Stop and rotate

Call `workspace_stop` with `workspace_id` and `confirm=true`.
Manage API keys at https://awfl.us → Settings. Create a replacement, change
`AWFL_API_KEY` in the private ChatGPT Site secret settings, then revoke the
previous key. Revocation blocks future MCP requests but does not kill
already-running commands; stop the workspace when rotating credentials.
