# AWFL document storage: PostgreSQL selection and platform-agnostic migration plan

**Decision (November 14, 2026 ET): PostgreSQL is the selected destination for AWFL document storage.** Use the existing Cloud SQL PostgreSQL 15 **`db-f1-micro` shared-core** configuration in `us-central1`; do **not** upgrade to dedicated-core or make high-concurrency p99 tuning a prerequisite. Target an in-process, SDK-independent `Storage` interface, a separate PostgreSQL adapter, and an incremental migration from Firestore. See the [actionable PostgreSQL migration plan](postgres-storage-migration-plan.md).

**November 16 implementation update:** Jobs and its shared workflow routes have been migrated to the provider-neutral Storage entrypoint and exercised on both managed backends; the remaining data, deployment and legacy-durable/MCP cutover work is tracked in [Jobs document Storage migration](jobs-document-storage-migration.md). This work is not yet a production backend switch. The active two-phase handoff is [switch PostgreSQL in production, then investigate the remaining latency](postgres-production-cutover-latency-handoff-2026-11-16.md). Local Project Manager tests confirmed ~9× lower **native execution-store** cumulative latency (median 314 ms PG versus 2,811 ms Firestore; three runs per backend), **not** a measured all-Jobs Storage speedup. The local Jobs service also used the selected provider, but its individual DB calls were not separately timed; add interface-level timing after production cutover.

**Status (historical November 14 baseline):** Decision and managed-service benchmark complete; the full provider-independent contract, PostgreSQL application integration, data migration, and production switch are **not yet implemented**. The actual running application still uses Firestore. The initial single-record pilot is not the full Storage implementation.

**Scope:** Keep Firebase Auth/ID-token verification for now; the database decision does not require replacing authentication. Retain the existing Firestore adapter/compatibility path until migration finishes. Realtime Database remains a *tested alternative*, not the selected platform backend; no further RTDB work is needed absent a concrete requirement.

## Measured evidence behind the decision

The [managed-service benchmark](storage-pilot-managed-three-backend-benchmark-2026-11-14.md) exercised 1,800 successful native memory-root execution-state lifecycles against **actual managed GCP databases** from the same GKE consumer: 300 measured cycles per backend at concurrency 1 and 16, plus 25 warmups per condition; zero failures. These measure a scoped record/transaction lifecycle, not every server query or subscription.

| Operation (p50, ms) | Firestore `nam5` | RTDB `us-central1` | PostgreSQL `db-f1-micro` |
| --- | ---: | ---: | ---: |
| Sequential read | 11.39 | 18.20 | **1.16** |
| Sequential write | 30.49 | 21.20 | **1.90** |
| Sequential guarded completion | 45.06 | 40.49 | **5.20** |
| Guarded completion, 16 workers | 83.95 | 68.08 | **16.76** |
| Guarded completion p95, 16 workers | 206.30 | 167.46 | **81.64** |

PostgreSQL has **~8.7× lower median** guarded-completion latency than Firestore and **~7.8× lower** than RTDB sequentially. Disk durability was not turned off (`synchronous_commit=on`, `fsync=on`). Its 16-worker guarded-completion **p99 was 488.21 ms**, versus 280.94 ms (Firestore) and 266.21 ms (RTDB); that outlier is **explicitly accepted for the current no-paying-customer scale**. Monitor it, but do not block or expand the instance tier solely to reduce p99. Reconsider sizing only if actual production workload, reliability, or latency requirements justify it.

**Cost assumption:** `db-f1-micro` plus 10 GiB SSD is approximately **$10–15/month fixed** at the tested configuration, excluding additional storage, backup, networking, other AWFL services and variable usage. This is a planning estimate, **not an audited GCP invoice**. Keep resource spend lean; upgrade only from observed constraints. Use connection pooling sparingly with PostgreSQL's measured 25-connection limit.

**Current priority (supersedes the November 14 pilot follow-up):** Merge and production-configure the already implemented Jobs + native memory-mode Storage migration with Terraform, a finite data backfill and full API/Jobs/GKE route verification. Document the legacy durable/MCP exceptions explicitly. **After PostgreSQL is serving the production data plane**, instrument all Jobs Storage method calls and investigate HTTP/auth/LLM/callback/GCS/Rust end-to-end latency. See [cutover + latency handoff](postgres-production-cutover-latency-handoff-2026-11-16.md). Further adapter-tier benchmarks and new ORM/package extraction are not prerequisites.

## Historical Phase 0A — completed database investigation (November 14, 2026)

**Historical investigation scope (implemented and benchmarked):** build the smallest executable storage contract around a native **memory-mode root execution's** lifecycle, and benchmark **Firestore (current `nam5`), Firebase Realtime Database (`us-central1`), and Cloud SQL PostgreSQL (`db-f1-micro`, `us-central1`)** using identical calls from the same AWFL GKE/Jobs environment. This supersedes the earlier assumption that the first phase has no alternative backend or infrastructure; it does **not** authorize a production data cutover.

Scope the pilot to `create/get/claim/progress/complete` on one root execution record, with safe owner/epoch fencing, cancellation-conflict behavior, create-only and concurrent-claim tests. Preserve existing `NativeExecutionStore` API semantics. Keep the public design objective of one complete document `Storage` interface including subscriptions and transactions, but explicitly distinguish **pilot-verified single-record semantics** from full platform conformance. An RTDB adapter must not silently claim support for Firestore cross-document transactions, collection-group queries, or subscriptions with identical ordering. These capabilities must be emulated with formally tested algorithms or fail closed before use; do not load an incomplete adapter as general production `Storage`.

Implementation steps:

1. Create an SDK-independent pilot operation contract and driver-level latency hook; add independent adapters for current Firestore, Admin SDK RTDB, and PostgreSQL using `pg`, with predictable errors and one stable JSON schema. Prefer provider-specific packages according to the long-term layout; a local workspace implementation is acceptable for the **experiment only**, with follow-up extraction tracked.
2. Apply the contract to a small, isolated **memory-root execution-state path** behind an explicit selection/injection boundary; default all production API/Jobs/agent execution to the unchanged Firestore path. Do not change durable effect journals, detached-branch ancestry validation or event subscriptions. Never route an existing in-flight execution to a different backend.
3. Add Terraform for a dedicated RTDB instance and Cloud SQL `db-f1-micro` PostgreSQL 15+ **ZONAL** instance (smallest supported disk), service APIs, database, IAM/network access and benchmark credentials. No committed plaintext passwords and no public authorized CIDRs. Use IAM database authentication and an authenticated Cloud SQL connector/proxy or private IP; permit a narrow benchmark SA only. RTDB instance/security rules must deny all end-user access; Admin-only benchmark paths. Keep the cloud resources separately identifiable and removable.
4. Validate correctness before latency: concurrent claimant fencing, expired lease, terminal result immutability, missing key, owner/epoch mismatch, cancel vs complete and replay; test small (1–4 KiB) and realistic 4–64 KiB payloads. Do not benchmark only raw writes when application requires transactional completion.
5. Run warmed, serial and concurrent benchmark operations with persistent SDK/database connections **from the same compute location**. Measure end-to-end `get`, `create`, `claim`, `progress`, `complete`; additionally report the corresponding raw read/write. Report p50/p90/p95/p99, per-operation count, failures, retries, concurrency, sample size, SQL sync durability and connection/TLS setup separately. Compare median and tail latency, not just aggregate time. Reuse only test records under a unique prefix and clean them after.
6. Commit adapter source, tests, Terraform and documented commands/results; record database version, tier, location and predicted ongoing cost. Keep Terraform state in the existing managed state workflow, never check in credentials. Do not claim benchmarks for a database unless the resources were provisioned and the operations actually executed.

**Exit: completed.** The three single-record pilot adapters and measured comparison are committed. The selected backend is PostgreSQL; see the implementation plan below. Full platform conformance and data migration are separate remaining tasks.

**Phase 0A completed — actual managed-service measurements:** [Firestore vs RTDB vs PostgreSQL 15 `db-f1-micro`, 1,800 successful execution lifecycles](storage-pilot-managed-three-backend-benchmark-2026-11-14.md), plus six committed raw JSON outputs. Firestore guarded completion p50 45.06 ms; RTDB 40.49 ms; PostgreSQL 5.20 ms. The older [read-only Firestore measurement](storage-pilot-managed-firestore-baseline-2026-11-14.md) was a pre-provisioning snapshot and does not supersede the completed benchmark.

**Local measured baseline:** See [storage pilot local PostgreSQL results](storage-pilot-local-results-2026-11-14.md) for actual 400+400-cycle measurements; serial local PostgreSQL completion p50 1.93 ms and p95 2.96 ms, with 16-concurrent p50 14.88 ms and p95 83.83 ms. This is not a Cloud SQL nor three-backend comparison.

**Historical implementation checkpoint (before managed resources were created, November 14, 2026):**
- Branch/PR: `feat/storage-execution-benchmark` / server PR #121. A local provider-neutral single-record `AtomicRecords` contract, `NativeMemoryExecutionPilotStore`, Firestore adapter, Realtime Database REST ETag CAS adapter, PostgreSQL JSONB adapter, common benchmark harness, Terraform stack and CI checks are implemented.
- Unit/mock SQL contract tests: 7 passing. Terraform 1.13.5 `init -backend=false` and `validate` succeeded using Google providers 7.46.2; this is syntax/schema validation, not a cloud apply.
- **Remaining after Phase 0A:** full platform Storage extraction, cross-document transaction/subscription conformance, and any actual production backend cutover. Live RTDB/Cloud SQL provisioning and benchmark measurements are complete; see the Phase 0A report above.
- **Resolved infrastructure authentication:** The GKE consumer has a separate injected **Google user OAuth token** with project Owner permissions; `gcloud auth list` incorrectly suggested the token itself belonged to `awfl-consumer`. Terraform used the user token for managed GCS state and provider access, provisioned RTDB and Cloud SQL, and reached a final no-change plan. Cloud SQL used workload identity `awfl-consumer` via IAM Auth Proxy for benchmarks. No unmanaged GCP resources or local Terraform state.
- **Release policy:** incremental code and safely disabled adapters can merge to `main` and flow through production CI/CD as tests pass. A real state-backend switch remains gated by per-provider correctness tests, live benchmark results and a consistent creation/read/execution routing plan, to avoid splitting in-flight records across databases.


## Decision

Expose **one storage interface** for all document persistence functionality: reads, writes, queries, counts, hierarchical collections, atomic mutations, batches, transactions, and realtime subscriptions. Subscriptions must not become a separate service or optional interface. An adapter implementing this contract is a complete storage backend.

Keep the document storage contract independent of Firebase, Google Cloud, Express, HTTP, identity, and the Rust workflow runtime. Extract its implementation into two separately versioned open-source packages:

- **awfl-us/storage**, package name **@awfl-us/storage**: the public contract, value/query/error types, validation and driver-independent contract-test suite. No Firebase/GCP dependency. ESM for Node 22 with TypeScript declarations (server remains JavaScript).
- **awfl-us/storage-firestore**, package name **@awfl-us/storage-firestore**: an in-process adapter implementing the contract using Firebase Admin / Firestore, including SDK initialization, credentials, timestamps, query translation, listener handling, and error normalization. The Firebase SDK dependency lives here, not in @awfl-us/storage or application modules.
- **awfl-us/server**: chooses the adapter at the API/Jobs/worker *composition root*, injects Storage into services, and knows only the @awfl-us/storage contract in its domain and workflow code. At runtime the Firebase adapter and SDK are still loaded into the same process; this is a **package boundary, not a new network service**. We must not add a proxy hop to each database operation.

These are proposed repositories/packages and provisional package names (verify package-registry scope ownership before publishing), not already-created deliverables. Keep package distribution pinning, CI and release automation explicit; use pinned released versions or immutable SHAs, not mutable branch dependencies. All adapters run the same conformance suite. Do **not** adopt an ORM or a key-value-only library as the platform-wide interface. Start with `pg` and explicit, parameterized SQL for the selected Postgres adapter; an ORM/query builder is optional only if it solves a measured maintainability problem. SQL must not leak into the shared API.

## High-level code audit (server main at 2e1dbae)

The tracked JS/TS scan found approximately **40 runtime files importing firebase-admin/firestore**, among **46 runtime files** with direct Firestore operations or references (some services pass injected SDK handles without importing the module themselves). These figures exclude most test and fixture paths and are audit indicators rather than an exhaustive AST-based call graph. Additional Firebase Admin imports handle authentication and app initialization. The server package currently directly depends on firebase-admin. There are also independent GCP APIs unrelated to the document database.

| Area / representative files | Current coupling | Migration-critical semantics |
| --- | --- | --- |
| Native execution and scheduling: workflows/native/executionStore.js, callbackEffects.js, backend.js, jobs/native.js | Firestore transactions, document references, nested effect journals, root leases, asynchronous recovery, callback subscriptions | Create-only, atomic compare/claim and fencing, multi-document ancestor validation, conditional updates, live callback wakeups. Preserve both durable and memory execution semantics. |
| MCP tools / orchestration: mcp/service.js, agentsMcp/service.js | Injected Firestore handle, many read-modify-write transactions, document listeners for wait/command output, query counts | Atomic request claims, no double tool execution, response wakeups, bounded listeners and cancellation. |
| Events / SSE: workflows/events/model.js, index.js, cursors.js | Query listeners, ordered replay, Firestore event persistence, cursor sentinels | Initial snapshots plus change events, no missed events between catch-up and subscribe, subscriber cleanup, ordering, two collection writes for events with a session. |
| Context, sessions, message history: workflows/context/lib/prakriya.js, context.api.js, collapseIndexer.js and filters; jobs/loadConvoHistory.js | Timestamp range queries, batches, subcollections, async message filters, projection | Order/pagination, nested path model, historical Timestamp types, indexing, high-volume batched writes. |
| Agent/project/workspace/task management: workflows/agents, projects, workspace, tasks.js, tools, prompts, types, definitions | CRUD, filters, ordered queries, path-scoped resources, project locks | Authorization and ownership are enforced above storage; preserve scoped paths, predictable conflicts and query order. |
| Jobs-facing API: jobs/firebaseDbApi.js, workflows.exec.js, callbacks, llm.js, llm/usage.js | Generic CRUD endpoint, lock transactions, listCollections, reverse pagination, usage increments, collectionGroup query | Preserve existing endpoint responses, update semantics and atomic counters; no Firestore-specific values in public responses. |
| Identity, credentials, OAuth: workflows/auth/identity.js, userAuth.js, utils.js, jobs/producer/auth/firebaseTokens.js | Firebase Admin Auth / ID-token verification plus stored API keys, OAuth credentials | **Distinct provider boundary**; switching databases does not change Firebase ID tokens, identity mapping, or credentials. Must not remove Firebase Auth accidentally. |
| Frontend/CLI | Web uses firebase/app and firebase/auth, plus Timestamp-like display conversion. Python CLI has Google/Firebase sign-in and refresh logic. | Mostly authentication coupling rather than direct Firestore client access. Replace client identity provider later behind a platform login abstraction without forcing a database migration. |

Inventory-specific features currently used: collection/doc paths and subcollections; set/merge/create/update/delete; ordered and filtered queries (including IN, range, projection, forward/reverse cursors and limit-to-last); aggregate count; collection-group queries for LLM usage; Firestore batches and multi-document transactions; onSnapshot for document and query subscriptions; FieldValue.increment and serverTimestamp; Firestore Timestamp conversion; optimistic concurrency and epoch-based fencing. Additional Firestore-dependent callers lacking SDK imports still need migration, particularly MCP.

### Important boundaries: not document storage

The existing docs/STORAGE.md describes GCS-backed **object/filesystem** storage and is not this database interface. Also out of scope for the first migration: Cloud Tasks queues, Workflows APIs, GCS artifacts and file mounts, Pub/Sub, GKE/Cloud Run jobs, IAM/OIDC, GitHub credentials and network transports. Those warrant **separate small provider contracts** when making the wider platform portable. Do not add all cloud services to the database Storage interface.

## Proposed single contract

The following is conceptual API shape; finalize names and input/output types with executable contract tests before migration.

    interface Storage {
      get<T>(path: DocumentPath, options?: ReadOptions): Promise<Doc<T> | null>;
      create<T>(path: DocumentPath, value: T): Promise<void>;
      put<T>(path: DocumentPath, value: T, options?: { merge?: boolean }): Promise<void>;
      update(path: DocumentPath, changes: Patch): Promise<void>;
      delete(path: DocumentPath): Promise<void>;
      query<T>(spec: QuerySpec): Promise<QueryResult<T>>;
      count(spec: QuerySpec): Promise<number>;
      listCollections(documentPath: DocumentPath): Promise<string[]>;
      batch(writes: WriteOperation[]): Promise<void>;
      transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T>;
      subscribe<T>(target: DocumentTarget | QuerySpec, listener: SubscriptionListener<T>):
        Promise<Unsubscribe>;
      close(): Promise<void>;
    }

TransactionContext is a transaction-scoped handle with get/query/create/put/update/delete and a single atomic commit at the end of the callback, **not** a second general-purpose storage interface. It explicitly cannot subscribe or launch network effects from within the callback. Use a single public Storage interface for all capabilities, including subscribe.

- **Paths:** DocumentPath / CollectionPath are opaque validated hierarchical string paths, not SDK DocumentReference objects. Preserve existing users/{userId}/projects/{projectId}/... layout and nested subcollections. Do not embed user authorization in an untrusted caller-supplied path: service-level authenticated scope construction is mandatory.
- **Read and write semantics:** create fails on existence; put overwrites unless merge is explicit; update rejects missing documents; delete behavior is specified; get returns document id, path and data rather than an SDK snapshot. Define return/revision metadata and duplicate/not-found behavior before converting handlers.
- **QuerySpec:** collection and collection-group targets, filter operators, order, limit, field projection, forward/backward cursor, reverse-window query and deterministic tie-break on document ID. Count has the same filter semantics. Define restrictions/index requirements explicitly; never silently convert a server-side indexed query into an unbounded full scan.
- **Updates:** represent atomic increment, server timestamp and field delete as storage-owned typed patch operations, not Firebase FieldValue sentinels. Provide portable error codes (NOT_FOUND, ALREADY_EXISTS, CONFLICT, INVALID_QUERY, UNAVAILABLE, PERMISSION_DENIED) and error causality.
- **Data model:** distinguish null/missing, int64 versus floating point, UTC timestamp/Date, byte values, arrays/maps and nested depth. Preserve existing Firestore wire representation during the first migration. Convert Timestamp and other SDK objects at adapter boundary; no SDK objects or document references cross into services or public HTTP responses. Any legacy Firestore-shaped values require explicit compatibility normalization.
- **Transactions and batches:** document their limits, atomicity, isolation, conflict-retry policy and callback re-execution. Firestore requires reads before writes in transaction callbacks; applications must not do irreversible effects within callbacks. Atomic lease/fencing and multi-document parent checks must retain the same guarantees. Transaction error translation must be fail-closed.
- **Subscriptions:** support both document and query targets from the same Storage object. Specify initial snapshot, ordered added/modified/removed changes, subscribe readiness, close/error behavior, unsubscribing, retry/reconnection, and consistency with a concurrent initial read. For MCP/callback waits and SSE, tests must verify zero missed terminal events and no resource leaks. Future SQL adapters may implement watch with a durable change log and notification wakeups; simple polling alone is insufficient for strong guarantees without a documented cursor.
- **Performance/observability:** include an SDK-neutral interceptor/hook for operation count, monotonic latency, retries, failures, and wall-time overlap; include transaction and subscription lifetime metrics. No document bodies, identities, secrets or arbitrary paths in labels. AsyncLocalStorage can correlate requests and execution IDs without threading custom telemetry through every call. Keep the hot path in-process; the abstraction must not add remote hops.

This contract must support **all** defined operations; don't silently mark subscriptions/transactions as optional. An adapter unable to implement contract semantics fails conformance tests and must not be configured as production storage.

## Package and dependency structure

    @awfl-us/storage                 (zero provider SDK dependencies)
      src/contract              (single Storage interface, types, errors)
      src/testing               (reusable adapter conformance suite)
      src/telemetry             (SDK-neutral timing/count hook)

    @awfl-us/storage-postgres        (depends on @awfl-us/storage + pg)
      src/postgresStorage       (CRUD/query/batch/transaction and SQL schema)
      src/postgresWatch         (durable change log + LISTEN/NOTIFY wakeups)
      src/codec                (portable JSON, time and numeric types)
      test                     (real PostgreSQL contract and concurrency tests)

    @awfl-us/storage-firestore       (temporary compatibility adapter)
      src/firestoreStorage      (CRUD, query, transaction, batch)
      src/firestoreWatch        (snapshot subscriptions and unsubscribe)
      src/codec                 (values, timestamps, sentinels, snapshots)
      src/translate             (queries, cursor and errors)
      test                      (Firestore emulator conformance)

    awfl-us/server
      platform/createStorage    (composition root; driver selected at startup)
      workflows, jobs, mcp      (only imported Storage contract)
      application services     (injected Storage; no vendor globals)

Firebase Admin initialization must move out of arbitrary imported route modules. Current application code calls getFirestore and initializes Firebase at module import time in several places, and the API / Jobs entrypoints import modules before initializing application services. Change to explicit creation in each production entrypoint; retain a single, shared adapter instance or controlled per-process instances and close it on shutdown. Prefer constructor/factory injection over global setters and magic dynamic imports. The document store is shared between API, Jobs and GKE workers, not tied to a single HTTP request. The adapter, not application code, owns credentials and emulator targeting.

**Important separation:** removing firebase-admin from the server's own declared dependencies is only fully possible once **authentication** also moves to a provider package. Initial storage extraction will remove Firestore imports from domain modules but may retain firebase-admin in server for ID-token verification. A follow-up @awfl-us/auth-firebase (or broader identity provider package) can remove that final direct dependency. The Web app and CLI can continue Firebase login during the database migration.

### Config and rollout

The *current running server* starts with Firestore. The selected destination is `STORAGE_BACKEND=postgres` once the target has the required data and consistent routing. Initially expose the PostgreSQL adapter behind an explicitly bounded execution-state integration; do not enable a global switch until its module-specific operations are implemented. For existing workflow executions, keep a single backend from root creation through completion; drain or migrate active records as one coherent unit, not with per-request random selection. The adapter selection happens once at process startup; an unknown or non-conforming driver fails startup rather than falling back to an unrelated or empty database. No per-request remote adapter microservice. Keep public document paths, record IDs and HTTP/Jobs contracts stable while mapping the hierarchy to SQL tables and indexes. Do not assume Firestore's query/index layout maps directly to PostgreSQL; implement query-equivalent ordering, index and type semantics. Preserve authorization on the service side.

Develop and test in short, locally verified increments; merge working changes without waiting for deployments. For data cutover, **do not dual-write** or mix backends inside a transaction. Take an inventory/snapshot of any developer data worth keeping, copy/import it with explicit record counts and verification, and route *new* executions consistently to PostgreSQL once their paths work. Drain existing Firestore executions, or migrate their records and all dependent paths together. Do not assume that flipping a flag alone provides rollback after PostgreSQL-only writes; any fallback needs a deliberate data strategy. There are no paying customers, so favor an uncomplicated one-time cutover over long-lived compatibility scaffolding.

## Implementation order — PostgreSQL selected

**Source of truth for actionable tasks:** [PostgreSQL storage migration plan](postgres-storage-migration-plan.md). This replaces the older Firestore-only abstraction phases. The app currently runs on Firestore; the following steps are **planned**, not completed by the benchmark.

### M0 — contract and Postgres adapter foundation

- Update the existing Firestore call-site map across API, Jobs, MCP, native execution, event subscriptions and user/project services; capture exact behavior, indexes and data codecs.
- Build the one `Storage` contract and real-PostgreSQL conformance tests. Implement full `@awfl-us/storage-postgres` behind an in-process package boundary (`pg`, migrations, parameterized SQL) rather than making Firestore the sole target. Use separate interface and adapter packages; an in-repo workspace is fine while iterating, with extracted/versioned packages after stable tests.
- Keep the Firestore adapter as a compatibility reader/writer and test implementation until data cutover; do not invest in a full RTDB production driver.

### M1 — first functional migration: native memory-root execution state

- Upgrade the pilot native memory store into the real Jobs execution lifecycle (create, claim, progress, complete/fail, cancellation and readback) using PostgreSQL. Preserve user/project scope, owner/epoch/lease checks, single-root backend routing and nonblocking memory execution semantics.
- Run real compiled Rust workflows and 16-way racing-claim/stale-owner/cancel/replay tests against the managed PostgreSQL instance. Only treat this slice as integrated when execution creation and all worker operations use the same provider, not just the synthetic benchmark.

### M2 — durable/native child state and callbacks

- Port durable effects, journals, parent/child fork ancestry, restart/replay, parallel joins, callbacks and detached execution schedules. Keep multi-record checks within one SQL transaction. Do not reintroduce unnecessary synchronous journaling to memory mode.
- Verify no missed callbacks, no duplicated external effects and no stale worker overriding a completion after cancellation or restart.

### M3 — all remaining document CRUD, queries and subscriptions

- Migrate projects, agents, tasks, credentials, context/history, pagination, usage counters, collection-group queries, Events/SSE, MCP/Agents MCP and Jobs compatibility endpoints via `Storage`, without changing public API/compiled-workflow protocols.
- Implement `Storage.subscribe` with durable PostgreSQL change replay and `LISTEN/NOTIFY` wakeups; notifications alone are not persistence. Define commit-safe scoped cursors and test snapshot/replay/watch races across server processes. Add explicit indexes for real query shapes.
- Remove Firestore SDK calls and vendor data types from domain/application modules; preserve Firebase Authentication as an independent concern.

### M4 — one-time data migration and cutover

- Inventory developer/test Firestore data and active executions. Snapshot/export anything still needed; migrate/verify relevant documents with consistent paths/IDs or explicitly archive/reset disposable test data. There are no paying customers, so avoid permanent dual-write and long-lived shadow migrations.
- Move new execution roots to PostgreSQL consistently; drain or migrate any existing Firestore executions together with children, journals and callbacks. Finish backend selection at composition roots and check full Project Manager, session, SSE and MCP flows.
- Review recovery/backups and Terraform ownership before the SQL instance stores important data. Keep `db-f1-micro`; the current bench Terraform stack must not be destroyed while its SQL instance becomes AWFL's database of record. Retire unused RTDB and Firebase document-storage resources deliberately after parity, not as part of a blind stack destroy.

**Done:** full server document persistence uses the provider-neutral contract backed by PostgreSQL, with Firebase Auth unaffected; effective query/subscription/transaction behavior is tested, no hidden Firestore writes remain, and infrastructure remains managed by Terraform. Fast local development and commits are preferred; no dedicated-core/p99 tuning milestone.

## Testing matrix and acceptance gates

| Test | Required result |
| --- | --- |
| Contract import boundary | @awfl-us/storage imports without firebase-admin or Google SDK; API/Jobs application has no direct Firestore imports after full migration. |
| CRUD and namespace | All document operations, nested collections and scoped paths preserve current production behavior; missing/duplicate errors normalized. |
| Queries | Filters including IN and range; ordered pagination/reverse; projection; collection-group; counts; same observable results as Firestore. |
| Transactions | Atomic create/claim, conflict retry, concurrent leases, owner validation, stale-worker fencing and nested fork ancestor guarantees. |
| Subscriptions | Initial replay, concurrent writes during subscribe, ordered changes, unsubscribe, reconnect and bounded resource usage; SSE/MCP completion not lost. |
| Data compatibility | Firestore source documents are inventoried/snapshotted and relevant data copied into Postgres with verified paths/IDs, timestamps, nested maps, integer safety, cached native slots and usage counters; disposable test data reset explicitly only. |
| Runtime | Real Project Manager memory and durable executions, callback wakeups, asynchronous continuation, recovery after worker restart, no unexpected journals. |
| Security | Auth boundaries intact, no privilege escalation via guessed document paths, provider errors fail closed, secrets not logged. |
| Performance | Compare full real workflow p50/p95 against the actual managed pilot baseline; monitor high-concurrency p99 but do not gate the migration on dedicated-core benchmarking or a size upgrade. No additional adapter network hop. |
| Cutover and recovery | Backend chosen consistently per execution; no mixed-backend transaction, no lost running children; restore/rollback strategy accounts for Postgres-only writes and real backups. Terraform remains source of infra changes. |

## Risks and explicit non-goals

- **Cannot treat Firebase Firestore semantics as universal.** SQL implementation must preserve transaction, query/index and subscribe guarantees or clearly negotiate a new storage contract version, never silently change behavior.
- **Listener delivery is a correctness dependency.** MCP tool completion and SSE event availability are not just UI niceties; reconnect/catch-up and unsubscribe behavior must be specified.
- **Storage abstraction alone is not a latency fix.** The actual managed Postgres pilot **does** establish lower database latency for this execution-state workload. Keep adapters in-process, with no extra app-level HTTP hop, and instrument the real compiled-workflow path rather than assuming the pilot covers every operation.
- **Data migration is now in scope.** PostgreSQL is selected as the target; keep it simple with explicit inventory, verified finite copy/cutover and consistent root-execution routing. Do not add unrelated GKE services, rewrite the DSL or replace Firebase Authentication as part of this decision.
- **Do not alter production execution mode.** The memory-first flag was intentionally enabled in production at the time of this audit; preserve it and test both memory and durable paths.
- **Preserve test-first portability.** Do not call the server portable while any non-provider module still imports the vendor SDK or exposes Firestore-specific return types.
