# Context Agent (functions/jobs/context/AGENT.md)

Role
- Subject-matter expert for the Context module under functions/jobs/context.
- Answers questions, plans changes, and edits code/docs related to TopicContextYoj and its filter pipeline.

Scope and responsibilities
- Endpoints
  - POST /context/topicContextYoj/run
  - POST /jobs/context/collapse/indexer/run (router-mounted path; route path is '/collapse/indexer/run')
- Assembly model
  - model.intro: optional system intro
  - model.promoteUpstream: boolean to pull upstream context
  - model.components: array of components assembled into messages; supports kinds: yoj, ista, literal
    - Nested composition via children (grouping only): components may include `children` (array) for organizational hierarchy
      - Traversal: depth-first, left-to-right
      - Emission: only leaf components (no children) produce messages; parents do not emit additional output
      - literal components cannot have children (rejected with 400)
      - Validation limits: max nesting depth ≤ 6; max total component nodes (including parents and leaves) ≤ 128
  - model.filters: ordered array of filter names or { name, options }
- Filter pipeline (registry-based, composable, applied in order)
  - sizeLimiter (default first in general defaults)
    - Purpose: keep context under a token budget by greedily retaining newer messages first; can prioritize system and/or user messages when configured; preserves at least one system if configured.
    - Options:
      - maxTokens: number (default 24000 in defaults; 20000 in TopicContext preset)
      - tokenizer: function override (defaults to approx chars/4)
      - perMessageOverhead: number (default 8)
      - prioritizeSystem: boolean (default false)
      - prioritizeUser: boolean (default true)
      - preserveAtLeastOneSystem: boolean (default true)
      - maxContentChars: number (default 50000); pre-truncates very large message content before estimation/selection
    - Behavior: greedy newest-first selection; when prioritizeSystem and/or prioritizeUser are true, preference order is system → user → others (assistant/tool), each greedily newest-first; token accounting is over the entire message object (JSON) not just content; stabilizes budgets by pre-truncating oversized contents
  - collapseGroupReplacer (preset-enabled)
    - Purpose: replace sequences of messages belonging to the same collapsed group with one synthetic 'system' placeholder per group, ordered by first appearance.
    - Data sources (user-scoped preferred):
      - users/{userId}/convo.sessions/{sessionId}/indexes/collapsed/messageToGroups/{docId}
      - Optional enrichment from: users/{userId}/convo.sessions/{sessionId}/collapsed/{responseId}
      - Legacy fallback (non-user-scoped): convo.sessions/{sessionId}/indexes/collapsed/messageToGroups/{docId} and convo.sessions/{sessionId}/collapsed/{responseId}
    - Output: system message with JSON content: { type: 'collapsed_group', name, responseId, description?, items? }
      - Note: Placeholder no longer includes messageIds. Description is read from CollapseResponse groups, supporting either `data.groups[].description` or `data.value.groups[].params.description` and `data.value.groups[].items` shapes.
    - Requirements: ctx.sessionId and (when available) ctx.userId in filter context; works best when includeDocId is true so messages carry docId.
  - toolCallBackfill (kept last)
    - Purpose: normalize tool-call sequences after trimming and ensure each assistant tool_call has a tool reply
    - Behaviors:
      - Ordering normalization: move all tool responses that correspond to an assistant tool_call so they appear immediately after the assistant message that issued the call, even if interleaved user/assistant messages originally appeared in between; preserve multiple tool responses per call in their original relative order.
      - Backfill: insert a synthetic tool reply immediately after the assistant message that issued the tool_call when missing
      - Orphan handling: convert tool messages that lack a matching in-window assistant tool_call to role: "system"; strip tool_call_id by default
    - Options:
      - missingContent: string (default message for synthetic tool replies)
      - role: string (role to use for synthetic tool replies; typically "tool")
      - orphanRole: string (default "system")
      - stripOrphanToolId: boolean (default true)
- Default filter order (general default when no preset/model filters provided)
  - [ { name: "sizeLimiter", options: { maxTokens: 24000 } }, { name: "toolCallBackfill" } ]
  - Rationale: prune first, then normalize tool-call chains on the final window
- TopicContext preset filter order
  - [ { name: "collapseGroupReplacer" }, { name: "fileContentsLimiter", options: { filesLimit: 7, versionsPerFile: 2 } }, { name: "sizeLimiter", options: { maxTokens: 20000 } }, { name: "toolCallBackfill" } ]
  - Rationale: collapse groups early to shrink the window before content/file pruning and token budgeting; always run toolCallBackfill last

Key files
- functions/jobs/context/topicContextYoj.js: assembles messages and applies the filter pipeline
- functions/jobs/context/filters/index.js: filter registry + applyFilters (async) + registerFilter
- functions/jobs/context/filters/sizeLimiter.js: size limiting filter (with maxContentChars)
- functions/jobs/context/filters/toolCallBackfill.js: tool-call normalization/backfill
- functions/jobs/context/filters/collapseGroupReplacer.js: collapsed-group replacement filter (now user-scoped when ctx.userId is provided)
- functions/jobs/context/modelDecoder.js: parses model, presets, filters (supports nested components and validation limits)
- functions/jobs/context/README.md: API documentation and examples (includes nested component traversal rules)

Usage examples
- Basic request
  {
    "kala": { "kind": "Topic", "topicId": "xyz" },
    "model": {
      "intro": { "system": "Context intro..." },
      "promoteUpstream": true,
      "components": [
        { "kind": "yoj", "name": "topicInfos", "framing": "Previously extracted topic info:\r" },
        { "kind": "yoj", "name": "summaries", "framing": "Previous convo summaries:\r" },
        { "kind": "yoj", "name": "messages", "framing": "Summary of older conversation messages:\r" }
      ],
      "filters": [
        { "name": "sizeLimiter", "options": { "maxTokens": 24000 } },
        { "name": "toolCallBackfill" }
      ]
    }
  }

Guidelines for this agent
- THINK before acting; prefer precise, minimal edits.
- READ_FILE only when necessary; UPDATE_FILE in small, atomic changes with clear diffs.
- RUN_COMMAND carefully and idempotently (dry runs preferred where possible).
- Keep the README and AGENT.md in sync with actual defaults (especially filter order and options).
- When changing filters:
  - Update README examples and defaults
  - Consider adding unit tests for edge cases (tight budgets, orphan tool messages, multi-tool scenarios, multilingual)
  - Consider telemetry for truncations, backfills, and orphan conversions

Maintenance notes
- sizeLimiter default maxContentChars: 50,000
- General default pipeline order: sizeLimiter first, then toolCallBackfill
- TopicContext preset pipeline: collapseGroupReplacer -> fileContentsLimiter -> sizeLimiter -> toolCallBackfill
- collapseGroupReplacer reads user-scoped paths when ctx.userId is provided; otherwise falls back to legacy non-user-scoped paths
- toolCallBackfill normalizes ordering (assistant tool_call followed immediately by its tool responses), inserts synthetic replies when missing, and converts orphan tool messages to system role by default
