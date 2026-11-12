# AWFL MCP: shared project consumer

Production endpoint: https://api.awfl.us/mcp

AWFL MCP uses the **existing** project-scoped Python consumer, GKE Job,
Firestore execution store and shared consumer lock, not another backend.

## Discover the environment

MCP clients receive concise **server instructions** on initialization. The
server publishes a guide resource at awfl://environment/guide via the standard
MCP resources/list and resources/read methods.

For actual environment facts, use the following tools:

1. projects_list then workspace_create with project_id. The workspace ID is a
   durable attachment; new workspaces do not have a one-hour expiration.
   Existing legacy workspace records are not migrated. Only explicit
   workspace_stop retires a new attachment. The consumer's one-hour *idle*
   shutdown is separate, and an existing attachment can start it again.
2. environment_status with workspace_id to see readiness, installed tools,
   GCP/GitHub credential availability, known token-file environment names and
   refresh configuration. This comes from the live project heartbeat.
3. A null environment means the heartbeat is absent or stale: **unknown**,
   not credentials absent.
4. run_command, command_output, read_file, apply_patch, search_files and
   list_directory work through the same project consumer.

The consumer publishes an allowlisted inventory on the existing
Firebase-authenticated heartbeat. The server checks the project lock
generation and sanitizes the inventory before storing it in Firestore. It
never returns token values or arbitrary environment variables.

## Credentials

When connected, CLOUDSDK_AUTH_ACCESS_TOKEN_FILE normally identifies
/tmp/awfl-google-access-token, while CLOUDSDK_CORE_PROJECT identifies the GCP
project. AWFL_GITHUB_TOKEN_FILE normally identifies /tmp/awfl-github-token.
Git uses a dynamic credential helper and freshly spawned Python tool
processes can receive updated GITHUB_TOKEN and GH_TOKEN values.

Credential presence is not a live OAuth/IAM verification. Never print,
copy, paste or log token-file contents.

An AWFL API key is distinct from Google Cloud and GitHub credentials.
The same AWFL key now authenticates `/workflows/*`, `/mcp` and `/mcp/agents`
through the shared identity resolver. Existing `mcp:invoke` keys continue
to work; new keys include `awfl:access` and `mcp:invoke`. Manage and revoke
them under web Settings > API Keys or through `/workflows/api-keys` with an
authenticated AWFL user token. A key never bypasses user/project or MCP
owner restrictions. Do not print or log key material.

## Execution and lifecycle

A workspace_id is an attachment to the shared consumer, not a new GKE Job.
Commands return durable execution IDs and support idempotency keys. Use
command_output for cursor-based output and command_input/command_cancel for
interactive tasks. A nonzero command exit remains a normal result.

Command results include timings_ms from existing server-side milestones:
submission (creation to dispatch), delivery (dispatch to claim),
execution (claim to completion), total (creation to completion), and
elapsed (current request age, frozen at completion). Missing milestones
return null; these include transport and callback overhead, not just
subprocess wall time. Use them to distinguish queueing from slow commands.

workspace_stop stops the **shared** consumer, can interrupt other attached
clients, and requires explicit confirmation.

The Python CLI is a **separate repository**, awfl-us/cli. After modifying
Python code, merge the CLI changes and pin the exact commit through
AWFL_CLI_REF in .github/workflows/deploy-cloud-run.yml. New container images
are used by newly launched GKE Jobs; existing Jobs are not silently replaced.

Tests: node --test mcp/tests/*.test.js (server);
python -m unittest discover -s tests -v (CLI).

## Native screenshot viewing

Capture a screenshot using Playwright inside the shared consumer, saving it to
an image file under /workspace. Then call view_image({workspace_id, path}) to
return a native MCP image block, rather than base64 text. The same consumer's
READ_FILE handler and path sandbox are reused; no extra Chromium service or
credential is required. PNG, JPEG and WebP are supported. Images must be at
most 640 KiB to stay within Firestore and callback size limits; for large
screenshots use Playwright's JPEG quality setting or a smaller viewport.
Pending view_image results can be retrieved with request_result, which also
returns the native image block when the read completes. Image magic bytes,
checksum and completeness are validated; partial images are rejected.
