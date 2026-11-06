# AWFL Cloud Execution MCP

Endpoint: `https://api.awfl.us/mcp` (Streamable HTTP, POST). Every request verifies
`Authorization: Bearer <AWFL API key>` through `requireAwflApiKey`, including fresh
Firestore expiry/revocation checks. This route is separate from Firebase web auth.
Only the configured `MCP_OWNER_UID` can invoke tools; unset configuration fails closed.

## Execution path

MCP SDK → Firestore workspace request → AWFL SSE stream → existing Python
`awfl run` consumer → `forward_event` → `handle_response` → execution runtime →
AWFL callback sender → stored result → MCP tool response.

The API process never executes client commands. The Python consumer understands
AWFL's existing `tool_call.function.name/arguments` envelope. Cloud mode adds
asynchronous subprocesses and scoped transport; ordinary workflow consumers are
unchanged. A workspace is one long-lived GKE Job, not one Job per command. It lasts
at most one hour, uses the same writable `/workspace` for all commands, and never
restarts/replays commands after pod loss. A new workspace does not recover files
from an expired/deleted workspace.

Tools: `environment_status`, `workspace_create`, `run_command`, `command_output`,
`command_cancel`, `read_file`, `write_file`, `workspace_stop`, `request_result`.
`run_command` returns initial output after up to 0.5s. Poll `command_output` with
`next_cursor` while `state=running` or `has_more=true`. If a tool call returns
`state=pending`, recover using `request_result`; do not repeat mutating commands.
Explicit `cwd` persists between commands; shell-local `cd` and `export` do not.

## Isolation and limits

One workspace per owner; four concurrent commands; 128 executions and 2,000 tool
requests per workspace; eight queued requests. Command timeout is 1–900 seconds.
Each command retains at most 1 MiB of output and is killed if it exceeds the limit;
poll responses return at most four 8 KiB chunks. All stdout and stderr cursors share
one ordered stream. Cancel/timeout kill the process group. Shell background
children are also killed when the foreground shell exits. Run foreground servers
as asynchronous commands instead of shell-daemonizing them.

Containers run as uid 1000, drop Linux capabilities, deny privilege escalation,
use a read-only root filesystem, and have bounded CPU, RAM and ephemeral volumes.
They use a dedicated KSA with no Workload Identity grant and no mounted Kubernetes
token. Child processes exclude transport credentials from their environments.
The consumer's capability authorizes only its own command stream and callbacks,
expires with the workspace, and is stored hashed in Firestore. Arbitrary code in
a workspace must be considered able to impersonate that workspace's consumer;
this capability confers no other user's access or GCP privileges.

NetworkPolicy denies ingress and limits egress to DNS plus public TCP/443. Private,
loopback, link-local and metadata networks are excluded. Other network ports,
including SSH git clones, are intentionally unavailable; clone over HTTPS.
Chromium runs with `--no-sandbox` inside the restricted container; the container
and network policy provide the execution isolation. This is private single-user
execution, not a hardened public hostile multi-tenant hosting service.

File tools reject paths outside the workspace and traverse directory components
using no-follow directory descriptors. Shell commands can access their container's
non-secret system files. Process counts, file sizes, and open descriptors are
bounded. MCP mutating tools carry destructive annotations; clients must obtain
approval for destructive operations. `workspace_stop` requires `confirm=true`.

## Deployment

The existing Cloud Run workflow builds a separate execution image from the pinned
Python CLI commit, applies `cloud/execution/policy.yaml` to the existing GKE cluster,
configures CA-verified Kubernetes access, deploys the API, and runs
`scripts/mcp-smoke.js`. The deployment identity must be able to apply namespace,
NetworkPolicy, quota and RBAC resources. The API identity gets a namespace-scoped
Job controller role. The execution KSA gets no cloud IAM roles.

Set repository variable `MCP_OWNER_UID` to the AWFL Firebase UID. For the initial
personal deployment only, if unset, deployment will select the sole distinct owner
of existing unexpired API keys. Zero/multiple owners abort deployment. This never
uses first-request claiming. `MCP_EXECUTION_IMAGE` and `K8S_CA_CERT_B64` are set by CI.

CI creates temporary 15-minute API keys for acceptance checks, never prints tokens,
and deletes their records in finally. It tests the actual HTTPS MCP transport,
revocation/expiry/other-user rejection, GKE execution, persistent reuse, incremental
output, cancellation, public HTTPS, Chromium/TintWiz, metadata denial and cleanup.
Actual results are uploaded as `mcp-smoke-results`. A passing unit suite is not
proof of a working deployment.

## Stop and rotate

Call `workspace_stop` with its workspace ID and `confirm=true`. It revokes the
consumer capability before deleting the Job; Kubernetes TTL removes completed
Jobs and the one-hour active deadline is a backstop. Firestore TTL removes request
and workspace records after one day. Failed Job deletion can be retried safely.

Manage user API keys at https://awfl.us → Settings. Create a replacement, update
`AWFL_API_KEY` in the future private Site's server-side secret settings, then revoke
the old key. Revocation prevents further MCP requests immediately. It does not
retroactively kill already-running shell commands; stop the workspace first when
needed. No API key belongs in source, HTML, tool definitions, logs, or chat.

Phase 2 (private Site/plugin) must not begin until the live acceptance test passes.

### One-time access bootstrap

The existing GitHub deployment identity had Cloud Run deployment/index-management
access but its Firestore data read failed during the first live deployment attempt.
Run `bash scripts/bootstrap-mcp-access.sh` once from this repository in Google Cloud
Shell as the project/cluster administrator, then re-run the latest deployment.
The script grants the deployer Firestore data access (needed to resolve the owner
and create/delete ephemeral smoke-test keys), cluster metadata/connection access,
and Kubernetes permissions limited to the `awfl-execution` namespace. It does not
grant GKE administrator, project owner, or any IAM permissions to execution pods.
The two project IAM bindings are also recorded in `infra/mcp_execution.tf`.
