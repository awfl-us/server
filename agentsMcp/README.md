# AWFL Agents MCP

**Endpoint:** `https://api.awfl.us/mcp/agents`

This is a separate stateless Streamable HTTP MCP server beside the existing
AWFL Cloud Terminal MCP at `https://api.awfl.us/mcp`.

Connect with an existing AWFL MCP API key (`Authorization: Bearer <key>`).
The exact same API key verifier, owner policy and Origin allowlist protect both.

## Model

AWFL Agents MCP **does not create another agent runtime**.

- `create_session` is the same Google Workflows launch used by AWFL Web's
  `/workflows/execute`, sharing `createWorkflowExecution`.
- It uses the same agents and `agentSessions` mapping as the Web session creator.
- `send_message` submits `query` to that same workflow and `sessionId`,
  rather than writing a separate message or opening a separate agent process.
- Session metadata is read from `convo.sessions`; messages are read from
  `convo.sessions/{id}/messages`. Both live in the existing user/project
  Firestore namespace.
- Latest status comes from the same `workflowExecsBySession` and
  `workflowExecStatus` stores used by Web.
- `terminate_session` delegates to `cancelExecutionChain`, which is the
  existing execution-tree cancellation and lock release logic.
- No new GKE Job, Pub/Sub topic, long-running worker, or session store.

## Workflow

1. `projects_list` and `list_agents` to discover a project and agent.
2. `create_session` with `project_id`, `agent_id` and `prompt`.
   Alternatively pass `workflow_name`; like AWFL Web, this creates a
   workflow-backed agent and links it to the new session.
3. Use `get_session` and `review_session` for status and recent messages.
4. Use `list_messages` with `end_cursor` for chronological transcript pages.
5. Use `send_message` with the same `session_id` to continue the agent.
6. Use `terminate_session` (requires `confirm: true`) to cancel active work.

`launch_batch` and `message_batch` process up to 10 sessions sequentially,
returning per-item success/failure. Partial completion is not rolled back.

AWFL's `fund` is the **per-execution dollar budget**, not Devin ACUs.
The default `fund: 1` and `model: gpt-5` match the existing Web client.
All new executions return immediately with `execution_name`. They can take
time to create session messages and status records.

**Never blindly repeat** `create_session`, `send_message` or batches after an
HTTP timeout. Query sessions/status first; a submission may have succeeded.

## Search and pagination

`list_sessions`, `list_messages`, `review_session` and
`search_session_matches` expose opaque pagination cursors.

`search_conversations` is a bounded, case-insensitive literal AND search
over recent session transcripts. It is not a full-text index. It currently
scans up to 100 messages per session and marks results incomplete when there
are more; follow the session pagination cursor and use
`search_session_matches` for more transcript pages. This avoids introducing
a second searchable session datastore.

Not all Devin concepts map to AWFL. No artificial ACU accounting, archive
state, attachment store or insight-generation service is introduced.

## Development and tests

```bash
node --test agentsMcp/tests/*.test.js mcp/tests/*.test.js
```

The CI and deployment pipeline run both suites. The new server is mounted
*before* the existing `/mcp` route so the old MCP endpoint stays unchanged.
