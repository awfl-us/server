# Jobs document Storage migration (November 16, 2026)

**Status: code migrated and integration-tested; production cutover NOT performed.**

Jobs and the shared modules it invokes now use `storage/service.js` to obtain the same
provider-neutral `Storage` implementation selected by `AWFL_DOCUMENT_STORAGE_BACKEND`
(`firestore` by default, `postgres` when explicitly configured). `jobs/index.js` still
initializes Firebase Admin for **authentication** and the separately maintained legacy
native executor; provider selection does not replace Firebase Auth.

## Migrated call sites

- Legacy `/firebase` document create/read/update/delete, temporal listing and per-session
  segment calculations, plus transaction-fenced session locks.
  `/firebase/update` retains merge-upsert semantics required by the live
  ProjectManager workflow when the parent conversation document is absent.
- Jobs execution-link registration and status updates, LLM key lookup and atomic hourly
  LLM usage counters, GCS conversation-history restoration, callback registration.
- Shared Jobs routes: tasks, agents/session mappings, tool definitions, context/YOJ
  history, collapsed group indexes and lookups, events/cursors/SSE subscriptions,
  project/workspace CRUD and consumer coordination locks/heartbeats.
- Producer launch credential refresh binding, project startup messages, GitHub PAT
  lookup, and GitHub App/Google Cloud integration records. The OAuth services retain
  their tested injectable DB call shapes via a **Storage-backed** compatibility bridge;
  no provider SDK is required for that persistence.
- Native **memory-mode** callback creation/wait/delivery uses the same Storage backend
  as its root; legacy native durable-mode still uses `NativeExecutionStore` and is not
  implicitly moved.

## Verification

All tests below were actually executed in an authorized existing GKE environment:

- `test/jobs/storageRoutes.integration.mjs`: live Firestore **pass** and live Cloud SQL
  PostgreSQL **pass** (CRUD, upsert, ordered lists, session locks, tasks, native callbacks).
- `test/jobs/projectStorage.integration.mjs`: live Firestore **pass** and live Cloud SQL
  PostgreSQL **pass** (project lock fencing/heartbeats, workspace lifecycle, OAuth record
  transactions, hourly usage aggregation, event replay and live subscriptions).
- Existing `jobs/jobsPrefix.test.js`, `jobs/loadConvoHistory.test.js`,
  `workflows/native/callbackEffects.test.js`, `workflows/native/jobsEffects.test.js`,
  `workflows/githubApp/tests/connect.test.js`,
  `workflows/googleCloud/tests/connect.test.js` and native Jobs/producer integration
  tests passed after the migration. Context Jest tests were unavailable in the
  GKE deps image (`@jest/globals` missing), not an application test failure.
- Test-only local Jobs/real Firestore/real OpenAI project-manager main execution completed
  with **59 effects**, **32 HTTP calls**, `BENCH_OK`, **8.03 seconds**. Three existing
  detached maintenance children still fail `unsupported subtraction operand types`
  in the Rust runtime (a separate compiler issue).

## Remaining production cutover gates

1. Select and configure the **same provider** for API, Jobs and persistent workers; do
   not route one session/project between Firestore and PostgreSQL. Configure the Cloud SQL
   connector/IAM via Terraform, using the existing instance and scoped service accounts.
2. Design and run a **one-time consistent data migration** for user/project records,
   integrations/credentials, conversations, tool definitions, task records, event streams,
   callbacks, execution links and usage. Backfill Firestore Timestamp values into the
   stable JSON-compatible representation. Use validation counts/checksums and a quiescent
   cutover window or explicit dual-write/catch-up protocol.
3. The **legacy durable native executor** and the MCP control-plane request/workspace
   storage still use Firestore SDK transactions. These must be migrated explicitly or
   remain on an intentionally separate Firebase control-plane store. Do **not** describe
   a PostgreSQL-selected system as fully Firestore-free until these are resolved.
4. Run full API + Jobs + GKE consumer end-to-end tests and production-representative
   event replay/reconnect tests after migration. PostgreSQL event delivery currently
   uses provider-neutral subscriptions, not the adapter's specialized durable event
   cursor; verify retention, reconnect gaps and ordered resume before cutover.
5. Verify `npm run test:context` in a complete dependency environment. The local
   `node --test` invocation does not execute Jest tests correctly.

No production configuration or Terraform has been changed by this migration commit.
