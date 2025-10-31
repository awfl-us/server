# Context API (TopicContextYoj)

Server-side utilities to build smart, modular LLM chat contexts from Yoj/Ista stores, with a composable post-processing filter pipeline.

This directory exposes an Express router that builds a message array and returns it to callers for downstream LLM usage.

## Endpoints

- POST /context/topicContextYoj/run
- POST /jobs/context/collapse/indexer/run (router-mounted path in code is '/collapse/indexer/run')

Response: `{ yoj: ChatMessage[] }` for TopicContextYoj; `{ ok: boolean, indexed_groups, indexed_messages, batches }` for the collapse indexer.

ChatMessage: `{ role: 'system' | 'user' | 'assistant' | 'tool', content: string, ... }`

Notes:
- When `includeDocId: true` is passed in the request body, each returned message will also include `docId` (the source Firestore document ID) when available.

## Collapse indexer

Purpose: Maintain per-session indexes derived from each CollapseResponse written by ContextCollapser so the UI can substitute raw messages with collapsed group references and expand groups on demand.

Source documents
- CollapseResponse writes (user-scoped): `users/{userId}/convo.sessions/{sessionId}/collapsed/{responseId}`
  - Legacy (non-user-scoped) fallback: `convo.sessions/{sessionId}/collapsed/{responseId}`
  - Shape: either `{ groups: [ { name, description, items: [ { type: "message"|"collapsed", id } ] } ], create_time }` OR `{ create_time, value: { groups: [ { name, params?: { description }, items? } ] } }`

Indexes (scoped per session; user-scoped root preferred)
- Base path (preferred): `users/{userId}/convo.sessions/{sessionId}/indexes/collapsed/*`
- Legacy fallback: `convo.sessions/{sessionId}/indexes/collapsed/*`

1) Message -> Groups
   - Path: `messageToGroups/{messageDocId}`
   - Doc shape (merge-friendly):
     `{ groups: { [GROUP_NAME]: { responseId: string, updated_at: number } } }`
   - Semantics: a message can appear in multiple groups; last write wins per group. Safeguard: if a message accrues too many groups, we spill keys under `byMessage/{messageDocId}/groups/{groupName}` with the same `{ responseId, updated_at }` payload.
2) Group -> Response
   - Path: `groupToResponse/{groupName}`
   - Doc shape: `{ responseId: string, updated_at: number, size: number }` (size = number of items in the group)
   - Semantics: group names are unique within a session; mapping always points to the latest response defining the group.
3) Optional reverse mapping (for cleanup)
   - Path: `responseToGroups/{responseId}`
   - Doc shape: `{ groups: string[], updated_at: number }`

HTTP job
- POST /jobs/context/collapse/indexer/run
- Request body: `{ sessionId, responseId }` or `{ sessionId, groups }` (the server infers `userId` from auth context if needed)
  - If `responseId` is provided, the job loads `.../collapsed/{responseId}` under the appropriate user-scoped root and indexes `data.groups`.
  - If `groups` is provided, the job indexes the provided array directly.
- Response: `{ ok: true, indexed_groups, indexed_messages, batches }`

Write behavior
- All writes are performed as batched upserts (merge=true) and chunked to a max of 400 ops per batch.
- Group names are sanitized to UPPER_SNAKE_CASE with non-alphanumerics mapped to `_`.
- `updated_at` is server time in seconds.
- Idempotent: rerunning with the same inputs only updates timestamps or last-writer-wins values; no duplicate array growth.

Example cURL
```
curl -X POST "https://<host>/jobs/context/collapse/indexer/run" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "s1",
    "responseId": "r123"
  }'
```
Or provide groups explicitly:
```
curl -X POST "https://<host>/jobs/context/collapse/indexer/run" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "s1",
    "groups": [ { "name": "PAST_DECISIONS", "items": [ { "type": "message", "id": "m1" }, { "type": "message", "id": "m2" } ] } ]
  }'
```

UI usage tips (substitution and expansion)
- Substitution (message -> group): when rendering a message with known `docId`, query `users/{userId}/convo.sessions/{sessionId}/indexes/collapsed/messageToGroups/{docId}` (or legacy root if userId is not available). If `groups[NAME]` exists, you can display a pill/tag for NAME and optionally hide the raw message.
- Expansion (group -> items): to expand a group, read `users/{userId}/convo.sessions/{sessionId}/indexes/collapsed/groupToResponse/{groupName}` to get `responseId` (or use legacy root), then load `users/{userId}/convo.sessions/{sessionId}/collapsed/{responseId}` and select the group with `name == groupName`. Use its `items` array to drive expansion. The `size` field in `groupToResponse` can be used for a quick UI hint without fetching the full response.
- Cleanup: if a response is retracted/superseded, `responseToGroups/{responseId}` lists impacted groups for targeted cleanup.

Security and limits
- This job runs server-side with admin privileges (firebase-admin). Ensure the endpoint is not exposed to untrusted clients or gate it behind admin auth.
- Writes are chunked to ≤400 ops per batch. Per-message docs spill to `byMessage/*` if more than ~200 groups would be stored under one document.

## Overview

- `topicContextYoj.js` orchestrates message building from:
  - Yoj/Ista components via `buildYojMessages`
  - Optional upstream promotion via `promoteKala`
  - Optional intro system message
  - Post-processing via a filter pipeline (see Filters)
- `modelDecoder.js` validates/normalizes the request and supports presets.
- `filters/` contains modular, composable filters and a registry.

## Request schema

Body JSON (simplified):
```
{
  "kala": { ... },                 // required (must include .kind)
  "model": {
    "intro"?: { "system"?: string },
    "promoteUpstream"?: boolean,   // include promoted Kala contexts first
    "components": [                // ordered components to include (supports nesting)
      { "kind": "yoj" | "ista", "name": string, "framing"?: string, "children"?: [<Component>] },
      { "kind": "literal", "value": string } // literal cannot have children
    ],
    // Optional, ordered filter pipeline; each entry is a string name or { name, options }
    "filters"?: [
      { "name": "sizeLimiter", "options": { "maxTokens": 24000 } },
      "toolCallBackfill"
    ]
  },
  "presetId"?: string,             // e.g. "TopicContext"
  "includeDocId"?: boolean         // default false; when true, include Firestore docId per message
}
```

Nested components (children)
- Backward compatible: models without `children` behave as before.
- Traversal and rendering:
  - We perform a depth-first, left-to-right traversal over `model.components`.
  - Only leaf components (those without `children`) produce output messages.
  - Parent nodes act as grouping/organizational nodes; their own `name/framing` do not emit additional messages.
  - This applies to both `yoj` and `ista` kinds.
- `literal` components are leaves only and MUST NOT have `children`. Requests that include `children` on a `literal` are rejected with `400`.

Validation limits
- Maximum nesting depth: ≤ 6 (inclusive). Exceeding this returns `400` with a clear error.
- Maximum total component nodes (including grouping and leaves): ≤ 128. Exceeding this returns `400`.

Notes:
- `presetId` is a convenience that provides a ready-made model (see Presets). If both `model` and `presetId` are provided, `model` is used.
- `framing` (when present) is prefixed to each message content pulled from that component.
- `includeDocId` is applied uniformly to upstream and local component messages where a backing document ID is available.

## Presets

Currently supported:
- `TopicContext`:
  - intro.system: "These are the previously extracted topic information, as well as the conversation context:\r"
  - promoteUpstream: true
  - components: topicInfos, summaries, messages (all Yoj reads with framing)
  - filters (default order):
    1. `collapseGroupReplacer`
    2. `fileContentsLimiter` with `{ filesLimit: 7, versionsPerFile: 2 }`
    3. `sizeLimiter` with `{ maxTokens: 20000 }` (and `maxContentChars: 50000` by default)
    4. `toolCallBackfill`

If no `model` or `presetId` is provided, the decoder defaults to an empty component list and applies the default filters `[ sizeLimiter(24000), toolCallBackfill ]`.

## Filters

Filters are small functions that take `(messages, options) => messages` and are applied in order via `filters/index.js`.

Available filters:
- collapseGroupReplacer
  - Purpose: Replace sequences of messages that belong to the same collapsed group with a single synthetic placeholder per group.
  - Data sources: Reads `users/{userId}/convo.sessions/{sessionId}/indexes/collapsed/messageToGroups/{docId}` (preferred) with legacy fallback to `convo.sessions/{sessionId}/indexes/collapsed/messageToGroups/{docId}`; enriches from `users/{userId}/convo.sessions/{sessionId}/collapsed/{responseId}` (or legacy root) when available.
  - Output: One synthetic `{ role: 'system', content: JSON.stringify({ type: 'collapsed_group', name, responseId, description?, items? }) }` per group, placed at the first occurrence. `description` is sourced from the CollapseResponse group entry, supporting both `groups[].description` and `groups[].params.description` under the `value` wrapper.
  - Requirements: Provide `ctx.sessionId` and (when user-scoped) `ctx.userId` in the filter context; works best when `includeDocId` is true so messages carry `docId`.
- fileContentsLimiter
  - Purpose: Reduce context bloat from file read/update tool traffic by redacting file contents beyond a rolling window per file and across files.
  - Behavior:
    - Scans from newest to oldest messages and detects:
      1) tool messages (role: 'tool') whose JSON `content` includes `{ filepath, content }`.
      2) assistant messages with `tool_calls[].function.arguments` JSON including `{ filepath, content }`.
    - Keeps full file payload for the most recent N distinct files (default 7). For each kept file, preserves the most recent M versions (default 2). All earlier occurrences have their payload replaced with a placeholder.
    - Only the payload field (`content`) is redacted; `filepath` and other metadata are preserved.
  - Options:
    - `filesLimit` (number, default 7) — maximum distinct filepaths to preserve with full contents.
    - `versionsPerFile` (number, default 2) — number of most recent versions per file to keep with full contents.
    - `placeholder` (string, default "(file contents ommited for space)") — replacement text for redacted contents.
    - `detectAssistantToolCalls` (boolean, default true) — inspect assistant tool call arguments.
    - `detectToolMessages` (boolean, default true) — inspect tool reply messages.
- sizeLimiter
  - Purpose: Restrict the total message budget to a token cap by dropping older messages and truncate any overly large message contents.
  - Strategy: Greedy newest-first selection. When `prioritizeSystem` is true, prefers newer system messages first; when `prioritizeUser` is true (default), prefers newer user messages; otherwise treats all messages uniformly by recency. If both are true, selection order is system -> user -> others (assistant/tool), each greedily newest-first.
  - Token accounting: Counts tokens over the entire message object (its JSON representation), not just `content`. This captures roles, tool/function metadata (e.g., tool_calls, tool_call_id, function arguments), and other fields.
  - Options:
    - `maxTokens` (number, default 24000)
    - `perMessageOverhead` (number, default 8)
    - `prioritizeSystem` (boolean, default false)
    - `prioritizeUser` (boolean, default true)
    - `preserveAtLeastOneSystem` (boolean, default true)
    - `maxContentChars` (number, default 50000) — truncate long contents before counting tokens
    - `tokenizer` (function) — server-side only; client JSON cannot pass functions. By default uses an approximate estimator (~4 chars/token).
- toolCallBackfill
  - Ensures each assistant tool call has a corresponding response, fixes orphan tool responses, and normalizes ordering.
  - Behavior:
    - Ordering normalization: moves all tool messages that correspond to an assistant `tool_call` so they appear immediately after the assistant message that issued the call, even if user/assistant messages were interleaved in between. Preserves multiple tool responses per call and their original relative order.
    - Appends a synthetic response for any assistant `tool_call` present without a corresponding tool message: `{ role: 'tool', tool_call_id, content: missingContent }`.
    - Converts orphan tool messages (whose `tool_call_id` has no matching assistant `tool_call` present) to `{ role: 'system', content: <same> }` to satisfy OpenAI's sequencing rules (by default strips `tool_call_id`).
  - Options:
    - `missingContent` (string, default: "Tool call failed to respond")
    - `role` (string, default: "tool") — role for synthetic backfills
    - `orphanRole` (string, default: "system") — role to use for orphaned messages
    - `stripOrphanToolId` (boolean, default: true) — remove tool_call_id from orphaned messages

Composition tips:
- In TopicContext preset, order is: `collapseGroupReplacer` -> `fileContentsLimiter` -> `sizeLimiter` -> `toolCallBackfill`.
- In general, run pruning/size filters (e.g., `sizeLimiter`) BEFORE `toolCallBackfill` so orphan detection, ordering, and backfills are accurate on the final window.
- If you include `fileContentsLimiter`, consider placing it before `sizeLimiter` to shrink oversized file payloads prior to token budgeting.
- Unknown filters are skipped with a warning.

## Upstream promotion

If `promoteUpstream` is true and a component is `yoj`/`ista`, the API also includes messages from promoted Kala(s) upstream of the given `kala`, using `promoteKala`. Upstream messages are placed before the local component messages, preserving chronological relevance.

## Examples

1) Use a preset (recommended for topic threads):
```
POST /context/topicContextYoj/run
{
  "kala": { "kind": "Topic", "topicId": "abc123" },
  "presetId": "TopicContext"
}
```

2) Explicit model with custom filter options:
```
POST /context/topicContextYoj/run
{
  "kala": { "kind": "Topic", "topicId": "abc123" },
  "model": {
    "intro": { "system": "Context intro..." },
    "promoteUpstream": true,
    "components": [
      { "kind": "yoj", "name": "topicInfos", "framing": "Previously extracted topic info:\r" },
      { "kind": "yoj", "name": "summaries", "framing": "Previous convo summaries:\r" },
      { "kind": "yoj", "name": "messages", "framing": "Summary of older conversation messages:\r" }
    ],
    "filters": [
      { "name": "fileContentsLimiter", "options": { "filesLimit": 7, "versionsPerFile": 2 } },
      { "name": "sizeLimiter", "options": { "maxTokens": 20000 } },
      { "name": "toolCallBackfill" }
    ]
  }
}
```

3) Collapse groups with docId and session context:
```
POST /context/topicContextYoj/run
{
  "kala": { "kind": "SessionKala", "sessionId": "s1" },
  "model": {
    "components": [ { "kind": "yoj", "name": "messages" } ],
    "filters": [
      { "name": "collapseGroupReplacer" },
      { "name": "sizeLimiter", "options": { "maxTokens": 22000 } },
      "toolCallBackfill"
    ]
  },
  "includeDocId": true
}
```

4) Redact historical file contents while keeping the most recent few per file:
```
POST /context/topicContextYoj/run
{
  "kala": { "kind": "Topic", "topicId": "abc123" },
  "model": {
    "components": [ { "kind": "yoj", "name": "messages" } ],
    "filters": [
      { "name": "fileContentsLimiter", "options": { "filesLimit": 7, "versionsPerFile": 2 } },
      { "name": "sizeLimiter", "options": { "maxTokens": 22000 } },
      "toolCallBackfill"
    ]
  },
  "includeDocId": true
}
```

5) Nested components (grouping with children):
```
POST /context/topicContextYoj/run
{
  "kala": { "kind": "Topic", "topicId": "abc123" },
  "model": {
    "components": [
      { "kind": "yoj", "name": "topicInfos" },
      { "kind": "yoj", "name": "group", "children": [
        { "kind": "yoj", "name": "summaries" },
        { "kind": "yoj", "name": "messages" }
      ]}
    ]
  }
}
```
Flattened render order: topicInfos -> summaries -> messages.

## Response

Success: `200 OK`
```
{ "yoj": [ { "role": "system", "content": "...", "docId": "..." }, { "role": "user", "content": "...", "docId": "..." }, ... ] }
```

Errors: `400 Bad Request`
```
{ "error": "<message>" }
```

Common error causes:
- Missing `kala.kind`
- Invalid component entries (e.g., missing `name` for kind `yoj`/`ista`)
- `literal` with `children`
- Exceeded nesting depth or total component count limits
- Unknown `presetId`

## Implementation notes

- Token counting is approximate by default (~4 chars per token) and is computed over the entire message object (JSON), not just its `content`.
- The router composes: intro -> components (flattened via DFS, leaves only, with optional upstream promotion per leaf) -> filter pipeline.
- `includeDocId` defaults to false; when true, the router passes this flag to all component builders, which attach `docId` where available.
- Filters receive a context `ctx` with `{ sessionId, userId }` when available to enable user-scoped reads.
- A server restart may be required to pick up new files/filters.
