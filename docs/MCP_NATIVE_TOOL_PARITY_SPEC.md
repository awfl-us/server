# AWFL MCP: Native Tool Parity Specification

**Engineering design proposal · Version 1.0 · November 2026**

## 1. Objective

Upgrade AWFL’s MCP interface so that an AI coding agent can operate its cloud environment with the same convenience, reliability, and control as a native development terminal and filesystem.

The target is functional and ergonomic parity, not necessarily identical internal implementations or proprietary tool schemas.

An agent should be able to:

- Execute commands immediately or asynchronously without managing consumer startup.
- Stream output and interact with long-running processes.
- Read, search, create, edit, and patch files efficiently.
- Maintain working directories and process state.
- Run concurrent operations safely.
- Recover from timeouts, disconnections, and consumer restarts.
- Use Git, Chromium, cloud credentials, and project services without special setup.
- Receive consistent, actionable errors.

**Architectural constraint:** Preserve AWFL’s existing project-scoped consumer, GKE Job, Firestore-backed state, and shared locking model. Do not create a second execution backend or duplicate consumer lifecycle logic.

## 2. Proposed MCP tool surface

The goal is to expose a small, coherent set of tools rather than many specialized variations.

| Tool | Purpose | Priority |
|---|---|---|
| run_command | Execute commands, optionally waiting for completion | P0 |
| command_output | Retrieve incremental output and execution status | P0 |
| command_input | Send stdin to a running process | P1 |
| command_cancel | Interrupt a running command | P0 |
| environment_status | Report readiness and runtime health | P0 |
| workspace_create | Attach to or start a project environment | Existing |
| workspace_stop | Stop shared environment with explicit confirmation | Existing |
| read_file | Read files with optional line or byte ranges | P1 |
| write_file | Create or replace files safely | Existing |
| apply_patch | Apply contextual, multi-file patches atomically | P1 |
| search_files | Search file contents or filenames | P1 |
| list_directory | Inspect directory entries and metadata | P2 |

Existing tools should remain compatible. Improvements should extend their behavior rather than forcing clients to migrate immediately.

## 3. Command execution contract

This is the highest-priority change.

### 3.1 Unified command execution

The existing run_command should accept a wait duration and return one consistent execution object, regardless of whether the consumer is starting, the command is queued, or the process is running.

Proposed input:

~~~json
{
  "workspace_id": "workspace-id",
  "command": "npm test",
  "cwd": "/workspace/project",
  "timeout_ms": 120000,
  "yield_time_ms": 10000,
  "max_output_bytes": 65536
}
~~~

Semantics:

- timeout_ms is the maximum permitted command execution duration.
- yield_time_ms is how long the MCP request may wait for a result before returning an execution handle.
- cwd sets the command’s working directory without requiring cd.
- max_output_bytes limits the initial response, not the total captured output.
- A command must never be submitted twice because an MCP response timed out.

Completed response:

~~~json
{
  "execution_id": "exec_123",
  "state": "completed",
  "exit_code": 0,
  "stdout": "42 tests passed\n",
  "stderr": "",
  "cursor": 183,
  "has_more": false
}
~~~

While starting:

~~~json
{
  "execution_id": "exec_123",
  "state": "waiting_for_consumer",
  "consumer": { "state": "starting" },
  "cursor": 0,
  "has_more": false
}
~~~

**Critical distinction:** execution_id must be available as soon as the server durably accepts the command, even before a consumer claims it.

### 3.2 Unified execution state machine

Canonical states: accepted, waiting_for_consumer, queued, running, completed, failed, timed_out, cancelled.

The server may retain additional internal states, but MCP clients should not have to understand them.

### 3.3 Idempotent submission

Every command should support an optional idempotency_key.

If the MCP request times out and the client retries with the same key, the server returns the existing execution rather than creating another command.

This matters for operations such as git push, database migrations, deployments, and file modifications.

Idempotency must be enforced by a durable, transactional uniqueness constraint scoped to the authenticated user and project. Reusing a key with different command arguments must return a conflict.

### 3.4 Output retrieval

~~~json
{
  "workspace_id": "workspace-id",
  "execution_id": "exec_123",
  "cursor": 183,
  "wait_ms": 10000,
  "max_bytes": 65536
}
~~~

The cursor must represent a stable position in a persisted output stream, not an offset in an ephemeral consumer buffer.

Requirements:

- Return only new output since the cursor.
- Preserve stdout/stderr channel identity and ordering metadata.
- Support long-polling until new output or state changes.
- Return final exit status when execution terminates.
- Allow reconnecting without losing previously captured output.
- Clearly indicate when output has been truncated or expired.
- Support commands that produce no output for long periods.

Recommended implementation: ordered sequence of output events, each with a monotonically increasing cursor.

### 3.5 Timeouts

| Timeout | Meaning |
|---|---|
| Consumer startup timeout | Maximum wait for an available execution environment |
| Execution timeout | Maximum runtime after the process actually starts |
| MCP response wait | Maximum time to hold a tool response open |

Do not count GKE startup time against the shell command’s execution timeout.

The command should remain queued until the consumer is ready, subject to its separate queue/startup deadline.

### 3.6 Interactive processes

Add command_input to support stdin, signals, and optional PTY-backed sessions.

~~~json
{ "execution_id": "exec_123", "input": "yes\n" }
~~~

Required behavior:

- Send text or binary input to the running process.
- Support EOF.
- Support SIGINT and SIGTERM.
- Allocate a PTY when explicitly requested.
- Support terminal dimensions for interactive applications.
- Ensure cancellation terminates the process group, not merely its parent shell.

PTY and non-PTY execution should be explicitly distinguished because output buffering, echo, and signal behavior differ.

## 4. Consumer readiness and lifecycle

Recent monitoring tests exposed an important problem: Kubernetes reported an active consumer Job before the consumer actually accepted commands.

AWFL must distinguish infrastructure health from application readiness.

### 4.1 Readiness model

~~~json
{
  "state": "starting",
  "consumer": {
    "id": "consumer_123",
    "job_state": "active",
    "readiness": "initializing",
    "connected": false,
    "last_heartbeat_at": null,
    "startup_phase": "connecting_to_server"
  },
  "queue": { "pending": 2, "running": 0 }
}
~~~

Suggested phases, derived from events rather than elapsed time:

- provisioning — GKE Job creation.
- pulling_image — image retrieval.
- initializing — process startup and credential initialization.
- connecting_to_server — consumer establishes connection.
- ready — consumer registers its ability to accept commands.

### 4.2 Consumer heartbeat

Publish consumer ID and generation, connection state, last heartbeat timestamp, available execution capacity, active execution IDs, runtime version and capabilities, and credential refresher health (without secrets).

A Job with an active pod but no heartbeat must not be reported as ready.

### 4.3 Startup behavior

Calling run_command during startup should automatically persist the execution, attach it to the existing project consumer, return waiting_for_consumer, dispatch when ready, and allow command_output to wait for the eventual result.

No additional workspace_create call should be necessary when the caller already has a valid workspace attachment.

### 4.4 Failure and recovery

| Situation | Required behavior |
|---|---|
| Consumer still starting | Keep requests queued |
| Consumer becomes ready | Dispatch queued requests |
| Startup exceeds deadline | Report consumer_start_timeout |
| Consumer crashes before claiming command | Keep command eligible for dispatch to replacement |
| Consumer crashes during execution | Report execution_lost unless resumability is explicitly supported |
| Project lock expires | Reconcile consumer state before acquiring replacement lock |
| Consumer replaced | Fence stale consumers with generation/lease tokens |

Never automatically replay commands that may have produced side effects; recovery favors correctness.

## 5. Filesystem tools

### 5.1 read_file

Support byte ranges, line ranges, and bounded output.

~~~json
{
  "path": "/workspace/project/src/server.js",
  "start_line": 100,
  "end_line": 180,
  "include_line_numbers": true
}
~~~

Requirements: UTF-8 text and explicit binary support, line numbers, size/mtime/content hash metadata, clear missing-path/directory/permission errors, consistent large-file behavior, no silent truncation, optional exact-version reads using a prior hash.

### 5.2 apply_patch

Most important missing filesystem capability:

~~~diff
*** Begin Patch
*** Update File: src/server.js
@@
-const timeout = 5000;
+const timeout = 10000;
*** Update File: src/config.js
@@
-export const retries = 2;
+export const retries = 3;
*** End Patch
~~~

Proposed input:

~~~json
{ "workspace_id": "workspace-id", "patch": "*** Begin Patch\n...", "atomic": true }
~~~

Requirements:

- Create, update, delete and move files.
- Support multiple files in a single patch.
- Validate all patch contexts before writing.
- Reject ambiguous matches.
- Preserve untouched bytes, line endings and permissions.
- Return structured data on every changed file.
- Support expected content hashes.
- No partial application when atomic=true.

Example response:

~~~json
{
  "ok": true,
  "files": [
    { "path": "src/server.js", "operation": "modified", "added_lines": 1, "removed_lines": 1 }
  ]
}
~~~

Use two phases: validate all changes, then commit. Multi-file atomicity requires staging and rollback; rename alone does not provide a multi-file transaction.

### 5.3 search_files

Support filename and content search.

~~~json
{
  "root": "/workspace/project",
  "pattern": "consumer_credentials",
  "mode": "content",
  "glob": "**/*.{js,ts,py}",
  "max_results": 100
}
~~~

Options: literal/regex matching, case sensitivity, context lines, hidden files, .gitignore handling, pagination. Results include paths, line numbers, excerpts, truncation indicators. Using ripgrep is reasonable.

### 5.4 list_directory and write_file

list_directory returns file type, size, permissions and modification time, optional recursion/depth limits.

write_file supports create_only, expected_hash, atomic replacement, optional parent-directory creation, explicit encoding and permissions, structured conflict errors.

Prefer apply_patch for modifications and write_file for new or completely regenerated files.

## 6. Working directory and session semantics

### 6.1 Default working directory

Workspace attachment exposes a default directory, ideally the project checkout. run_command may override via cwd. Record cwd in execution result.

A command's local cd must not change other executions' defaults.

### 6.2 Persistent shell sessions

~~~json
{
  "command": "python",
  "session_id": "shell_123",
  "pty": true,
  "yield_time_ms": 1000
}
~~~

Sessions may retain shell-local environment and cwd but never mutate global workspace state. Document the baseline.

### 6.3 Concurrency

Support multiple simultaneous commands per project consumer, configurable concurrency, independent process groups/output streams, fair dispatch, per-command cancellation, resource limits, and no implicit serialization of unrelated read-only operations. Provide controls for conflicting writes and Git operations.

## 7. Errors and response consistency

A successful MCP transport response must not become a tool failure merely because a shell command exits with code 1 (e.g., grep finds no matches).

Ordinary command failure:

~~~json
{
  "execution_id": "exec_123", "state": "completed",
  "exit_code": 1, "stdout": "", "stderr": "", "error": null
}
~~~

Infrastructure failure:

~~~json
{
  "execution_id": "exec_123", "state": "failed", "exit_code": null,
  "error": {
    "code": "consumer_unavailable",
    "message": "The consumer stopped before execution began.",
    "retryable": true
  }
}
~~~

Codes: invalid_workspace, consumer_unavailable, consumer_start_timeout, execution_lost, execution_timeout, permission_denied, file_conflict, output_expired, invalid_cursor.

Each error exposes machine-readable code, message, retryability and execution ID when available. Never expose secrets, private environment variables or arbitrary stack traces.

## 8. Security and authentication

Preserve authenticated project boundary:

- Commands run only under authenticated, authorized projects.
- Workspace/execution IDs are authorization-scoped, not bearer capabilities.
- GitHub credentials are retrieved dynamically from refreshed token file.
- Google Cloud credentials refresh without consumer restarts.
- Redact identifiable secrets from logs and tool responses.
- Never expose credentials via diagnostics.
- Destructive shutdown requires explicit confirmation.
- Audit command execution, file edits and cancellations.

Distinguish refreshed Git credential helper from GITHUB_TOKEN env used by other programs. Document and support both.

Do not expose arbitrary persistent environment-variable mutation across users sharing a consumer.

## 9. Implementation architecture

Enhance the existing execution path. One backend and one project consumer, with richer MCP capabilities.

| Component | Responsibility |
|---|---|
| mcp/tools.js | Tool schemas and descriptions |
| mcp/service.js | Workspace attachment, authorization, command dispatch |
| mcp/index.js | MCP registration and transport |
| jobs/producer/start.js | Shared consumer startup |
| jobs/producer/paths/gke.js | GKE consumer configuration |
| jobs/producer/gke.js | Kubernetes Job lifecycle and inspection |
| Consumer Python package (awfl-us/cli) | Command execution, filesystem, output handling |

Inspect existing command handlers and persistence schemas first. Extend them; do not add parallel request/output stores. One authoritative execution record per command across MCP, Firestore and consumer.

## 10. Acceptance tests

Complete only after testing against actual GKE consumer:

| Test | Expected result |
|---|---|
| echo hello on ready consumer | One call, exit 0, correct output |
| Command while starting | Automatically queued, executes later |
| 30-second command, 1-second yield | Execution ID returned, later completes |
| Retry after response timeout | No duplicate execution |
| Exit code 1 | Normal command result |
| 10 MB output | Complete paginated output, no duplication |
| No output for 60 seconds | Polling functional |
| Cancel process tree | All owned processes terminate |
| Crash before claim | Command remains dispatchable |
| Crash during execution | Explicit execution_lost |
| Patch three files | All modified correctly |
| Patch with invalid context | No files modified |
| Patch with stale hash | Conflict |
| Recursive search | Correct paths, line numbers, excerpts |
| Two independent concurrent commands | Both complete independently |
| Reconnect existing execution | Output and state retained |
| GitHub token rotates | Subsequent Git operation succeeds |
| Mobile Chromium test | Screenshot retrievable |

Test concurrent MCP clients and stale consumer lease fencing.

## 11. Performance targets

Proposed objectives, not measurements of current implementation.

| Metric | Target |
|---|---|
| Ready-consumer echo round trip | p95 under 2 seconds |
| Small file read | p95 under 1 second |
| Small contextual patch | p95 under 2 seconds |
| Initial acknowledgment | p95 under 1 second, excluding network latency |
| State visibility | Within 1 second |
| Output retrieval | No missing or duplicated chunks |
| Consumer startup | Measured separately |
| Duplicate side effects after keyed retry | Zero |

Measure MCP transport, server processing, queue wait, consumer startup, execution and output delivery separately.

## 12. Implementation phases

**Phase 1 — Execution reliability (P0).** Unify command lifecycle, idempotent submission, readiness, states, timeout semantics, error handling. Simple commands use one call, long commands have reliable resumable output.

**Phase 2 — Filesystem parity (P1).** Contextual patching, richer reads, recursive search, atomic writes. Routine repo edits need no shell workarounds.

**Phase 3 — Interactive terminal (P1).** PTY, stdin, signals, persistent sessions, controlled concurrency.

**Phase 4 — Hardening and compatibility (P2).** Concurrent clients, crashes, token rotation, authorization, compatibility tests.

## 13. Definition of done

An agent can, without AWFL-specific orchestration:

1. Attach to a project.
2. Inspect repository.
3. Search/read source.
4. Apply multi-file patch.
5. Run tests and stream output.
6. Start a development server.
7. Open app in Chromium, inspect screenshots.
8. Fix failure, rerun tests, commit.
9. Recover from consumer restart without duplicate effects or ambiguous state.

The agent need not understand Kubernetes Jobs, consumer IDs, Firestore documents, credential loops or internal locks.

## Final implementation guidance

Prioritize Phase 1, especially command lifecycle. Observable workflow and guarantee parity are the target, rather than undocumented native-tool internals.

**Success criterion:** If an agent can switch between native tools and AWFL MCP without changing how it plans, executes, edits, debugs and recovers from failures, AWFL has achieved intended parity.

*Reference-only specification. No code changes are included in this document.*
