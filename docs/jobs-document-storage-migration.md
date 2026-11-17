# Jobs document Storage migration (November 16, 2026)

**Status: Jobs document Storage code migrated and integration-tested on the `feat/jobs-document-storage-provider` branch; production cutover NOT performed.** The next-session deployment and latency investigation are tracked in the [November 16 handoff](postgres-production-cutover-latency-handoff-2026-11-16.md). This file describes branch behavior, **not** production or a complete Firestore removal.

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

## November 16–17 local Project Manager evidence — provider comparison

The compiled Rust `codebase-ProjectManager` workflow completed **three local executions per backend** with **59 effects** each, including two CLI tool callbacks and a locally started Jobs HTTP server. On each run the test runner selected *both* the native memory store and the Jobs service's `AWFL_DOCUMENT_STORAGE_BACKEND` (`postgres` or `firestore`). PostgreSQL reached managed Cloud SQL through IAM Auth Proxy; this is a real database, not a fake provider. These experiments **did not deploy the PostgreSQL backend into production** and used a test-only callback transport rather than the normal remote session launcher.

| Measurement (3 completed runs per backend) | PostgreSQL | Firestore |
| --- | ---: | ---: |
| End-to-end Project Manager execution times | 14.07, 10.18, 22.38 s | 14.70, 12.00, 19.80 s |
| Median end-to-end | 14.07 s | 14.70 s |
| Cumulative **native execution-store** calls | 314, ~229, ~649 ms | 2,811, ~2,091, ~4,192 ms |
| Median native execution-store calls | **314 ms** | **2,811 ms** |
| Jobs 26 HTTP POST effects, first pair only | 2.38 s total | 6.04 s total |

**Critical measurement boundary:** `storeTimed` wraps the *native execution-state store only* (`create/claim/updateMemoryProgress/complete/get`). **All Jobs document Storage method calls were not individually instrumented.** The total Jobs HTTP effects include network and application logic as well as database time; those figures are **not DB-only** and cannot be summed with concurrent execution-store timings. The observed median native-store improvement is roughly **9×**; it is **not** a measured 9× improvement across every Jobs database call.

All six main roots completed; three known detached Rust maintenance children failed in each run (existing `unsupported subtraction operand types` issue). A follow-up ten-run batch stopped during its fifth run when the AWFL GKE consumer died; only the four completed new runs were counted above. The prior Firestore **production** run (56.82 s) had a different execution/deployment path and must **not** be treated as a matched end-to-end baseline.

**Instrumentation still needed after cutover:** measure `get/create/put/update/delete/query/count/listCollections/batch/transaction/subscribe` at the provider-neutral Storage boundary inside **Jobs**, plus request/response timing by Jobs endpoint, SQL connection acquisition/queries/transaction retries, and callback/LLM/GCS/Rust subphase timing. See the linked handoff for the exact procedure.

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
