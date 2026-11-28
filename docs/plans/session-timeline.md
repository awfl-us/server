# Stable session timeline — Phase 3A-S

Companion to [the web stabilization plan](https://github.com/awfl-us/web/blob/main/docs/plans/session-chat-ux.md). Status: first additive server contract implemented and locally tested; deployment and web migration pending. Do not migrate web default until parity is verified.

## Findings

TopicContextYoj is a prompt projection. Promotion reads overlapping SegKala and SessionKala summary ranges and may include records from separate collections with equal bare document IDs; filters trim/reorder/backfill/collapse messages. Production comparison: default preset 17 rows/6 duplicate document-role groups; promotion without filters 16/6; local without promotion or filters 2/0. Preserve existing context and provider payload semantics. The web can inspect context separately.

`storage/service.js` already exposes the provider-neutral `query`, `get` and stable document-path cursors. Firestore and PostgreSQL order by the selected field plus document path in the same direction. Stored chat records use `data.value` and numeric wrapper `create_time`; wrapper cost and execId can fill missing fields in the message. The existing client router authenticates before project middleware and context routes; derive scope exclusively from authenticated req.userId and x-project-id, validate path segments, never accept body userId. No new storage, write path, event bus, or cloud resources required.

## Contract (v1)

`POST /workflows/context/sessions/timeline` with `{sessionId, limit?, before?, after?}`. Initial and before pages read newest first in storage then return chronological rows; after reads oldest unseen first for catch-up. Limit defaults to 30, max 50. Cursor is opaque and bound to the scoped collection. Cursor record must still exist; on deletion/change of its ordering timestamp return 409 and let client refresh the latest page. Storage creation time must be numeric and immutable; investigate malformed historical rows before default switch. No moving time-window eviction. Page rows expose opaque stable storage identity, wrapper timestamp, typed kind and original message (including tool correlation and responseId), with legacy cost/execId/docId backfill. No provider-side changes. Cursor-based navigation is for the raw transcript only; keep context, summaries, collapse-group controls and technical inspection on the existing endpoint during migration. A later revision may add a separate typed context projection; do not discard these capabilities.

- [x] Audit storage, context and auth boundaries.
- [x] Implement read-only page reader and protected route; test same-timestamp pagination, scope/cursor isolation, missing cursor, malformed records, raw tool ordering and unchanged context behavior.
- [ ] Verify adapter integration/production and historical parity. Assess response size and late-arriving/backdated records; define latest-page refresh and explicit mutation/removal policy before frontend migration.
- [ ] Add frontend controller and reversible switch; avoid duplicate state/timers and preserve existing live SSE correlation/scroll behavior. Test both data paths, old history loading, context inspection, physical mobile/authenticated web where available.
- [ ] Remove superseded paths only after CI and production evidence; update both repos' plans. Phase 4 remains gated.

## Initial implementation checkpoint

- Added isolated `readSessionTimeline` and authenticated client-only router; no changes to `TopicContextYoj`, filters or message persistence. Defaults 30/max 50 rows, ~4 MiB serialized row budget with full rows retained; `hasMore` follows query direction.
- Local context suite passed: 22/22 tests across three suites including seven new timeline contract tests. The new tests use an in-memory storage fake and Express/Supertest authorization-boundary fixture; real Firestore/Postgres adapter integration and production paging remain open. Added the context suite to pre-deployment CI (Node 22). Local consumer Node 20 emits engine warnings from dependencies.
- Cursor uses collection-bound scope hash, document ID and wrapper timestamp; invalid scope/path/limit rejected, missing or retimed cursor returns 409. Valid numeric timestamp required; legacy untimed records need separate audit. Cursor does not imply snapshot isolation or detect backdated mutations. No client migration or Phase 4 changes yet.
