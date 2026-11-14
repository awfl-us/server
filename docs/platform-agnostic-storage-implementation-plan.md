# AWFL platform-agnostic document storage: audit and implementation plan

Status: proposed design; audit and plan only. No runtime, SDK, data, IAM, or Terraform changes in this work.
Date: November 13, 2026 (ET).
Initial backend: existing production Firestore. Future backends: optional and not part of this migration.

## Decision

Expose **one storage interface** for all document persistence functionality: reads, writes, queries, counts, hierarchical collections, atomic mutations, batches, transactions, and realtime subscriptions. Subscriptions must not become a separate service or optional interface. An adapter implementing this contract is a complete storage backend.

Keep the document storage contract independent of Firebase, Google Cloud, Express, HTTP, identity, and the Rust workflow runtime. Extract its implementation into two separately versioned open-source packages:

- **awfl-us/storage**, package name **@awfl-us/storage**: the public contract, value/query/error types, validation and driver-independent contract-test suite. No Firebase/GCP dependency. ESM for Node 22 with TypeScript declarations (server remains JavaScript).
- **awfl-us/storage-firestore**, package name **@awfl-us/storage-firestore**: an in-process adapter implementing the contract using Firebase Admin / Firestore, including SDK initialization, credentials, timestamps, query translation, listener handling, and error normalization. The Firebase SDK dependency lives here, not in @awfl-us/storage or application modules.
- **awfl-us/server**: chooses the adapter at the API/Jobs/worker *composition root*, injects Storage into services, and knows only the @awfl-us/storage contract in its domain and workflow code. At runtime the Firebase adapter and SDK are still loaded into the same process; this is a **package boundary, not a new network service**. We must not add a proxy hop to each database operation.

These are proposed repositories/packages and provisional package names (verify package-registry scope ownership before publishing), not already-created deliverables. Keep package distribution pinning, CI and release automation explicit; use pinned released versions or immutable SHAs, not mutable branch dependencies. All adapters run the same conformance suite. Do **not** adopt an ORM or a key-value-only library as the platform-wide interface. A SQL driver can use Kysely internally when we actually build one; SQL must not leak into the shared API.

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

    @awfl-us/storage-firestore       (depends on @awfl-us/storage + firebase-admin)
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

Start with STORAGE_BACKEND=firestore and the same production Google credentials/database. The adapter selection happens once at process startup; an unknown or non-conforming driver fails startup rather than falling back to an unrelated or empty database. No per-request remote adapter microservice. Keep the existing document paths, schema, indexes, record IDs, and HTTP protocol stable throughout extraction.

Feature-gate any incremental migration of server modules, not database selection per individual request. A single logical write must use one backend and one atomic operation; **no dual-write** or mixed-backend transactions during the initial migration. Roll back service code/config to the old Firestore path without migrating data back. Do not toggle production database targets under an in-flight execution.

## Step-by-step implementation

### Phase 0 — baseline and contract specification

1. Build an exhaustive call-site inventory from AST/static search plus runtime traces, with module owner and required operations (including SDK handles passed through constructor parameters). Include API, Jobs, MCP, Agents MCP, background recovery, GKE consumer and CLI/Web boundary; keep the inventory in the plan/test suite.
2. Record representative production latency distributions (p50/p95) for native memory Project Manager, durable native execution/recovery, SSE, MCP command wakeups, task queries and LLM/accounting. Turn on bounded SDK-neutral timing later; do not log credentials or payloads.
3. Freeze the DB-neutral contract and data/transaction/watch semantics. Map existing Firestore indexes from firestore.indexes.json into query conformance cases. Define named operation/error types and stable value codecs.
4. Add an import-boundary/static lint rule that blocks new Firestore SDK usage outside the adapter and legacy migration allowlist, without initially breaking the existing server.

Exit: operation-to-module map, agreed contract semantics, baseline performance and executable conformance scenarios.

### Phase 1 — independent contract and Firestore adapter

1. Create the **awfl-us/storage** and **awfl-us/storage-firestore** packages/repositories and CI. The former must be importable without loading firebase-admin or any Google Cloud SDK. Include ESM exports, TypeScript declarations and pinned package releases.
2. Implement the Firestore adapter at the **current** existing Firestore database, with codec support for stored timestamps and legacy records. Keep backwards-compatible record formats; *do not* normalize/rewrite every document on read.
3. Implement the full conformance suite against the real Firestore emulator: create-vs-exists, missing/updates, merge, projection, count, group queries, cursors, nested collections, batch atomicity, transaction retries and conflicts, listener initial state and changes, cancellation and reconnect.
4. Provide a small in-memory **test-only reference implementation** of the contract if helpful for deterministic unit tests; it is not a production database and does not justify dropping stronger Firestore semantics.

Exit: standalone adapter package passes the entire contract in emulator; no AWFL business code migrated yet.

### Phase 2 — composition root and low-risk application migration

1. Create a single server storage composition root in API, Jobs, and persistent GKE process startup. Inject Storage into routers/services/handlers; remove module-scope getFirestore/initializeApp only as each caller is migrated. Keep identity-provider creation separate.
2. First migrate simpler bounded CRUD: agents, settings, projects, credentials, prompts, tool/type definitions, workspace metadata and tasks. Keep existing user/project scoping, API shapes and returned timestamps stable.
3. Move Jobs generic firebaseDbApi and related operations behind Storage while keeping the existing /firebase/* compatibility endpoints for compiled workflows. Rename or version endpoints only in a separate protocol change, **not** as part of this refactor.
4. Convert atomic counters and grouped usage queries via generic operators; verify accumulation under concurrent requests and not just a single-threaded unit test.

Exit: no regressions in normal CRUD, scoped project access and Jobs compatibility endpoints; no data migration.

### Phase 3 — queries, subscriptions, events, MCP and callbacks

1. Migrate context/history/collapse indexer, pagination, cursor storage and the paired event project/session writes. Preserve batch size, index usage, ordering, SSE replay and realtime query semantics.
2. Move document and query listeners in events/model.js and mcp/service.js to Storage.subscribe, with explicit initial snapshot/ready/cancel/error behavior. Validate consumer swaps and command-output wakeups when writes race with subscription startup.
3. Move callbackEffects and other callback flows to the shared subscription/transaction semantics; verify callback expiration, authentication, concurrent delivery and no duplicate callbacks.
4. Exercise realistic concurrency, callback timeouts, event replay and reconnects in the emulator with multiple server processes.

Exit: events SSE and MCP long polling are fully database-agnostic; no missed terminal notifications and no subscription leaks.

### Phase 4 — native execution and concurrency safety

1. Refactor NativeExecutionStore to receive the single Storage interface instead of a Firestore db handle. Preserve legacy persisted schemas, input/result JSON codec, release pinning, parent/child ancestry, leases, epochs and effect journal behavior.
2. Run durable protocol-v2, memory-first parallel, fork failure, replay/restart, detached background scheduler and multi-level cancellation tests against the adapter with **real** compiled Rust artifacts and a Firestore emulator.
3. Specifically test stale-worker fencing, two workers racing claim, multi-document ancestor validation and terminal cancel/complete. The memory executor must still have no per-effect journal and must not gain a new network hop.
4. Benchmark representative runs using the same pinned artifacts and equivalent API launch path, separating DB calls, app endpoints, GCS loading, native process and OpenAI. The abstraction's in-process dispatch overhead should be negligible compared with Firestore network time; investigate a consistent >5% p95 regression before rollout.

Exit: native state and MCP side effects retain at-least/exactly-once *as implemented today*; no new double-execution or unauthorized claims; memory-mode production remains enabled and verified after migration.

### Phase 5 — eliminate direct Firestore SDK imports from server business code

1. Remove remaining direct Firestore imports and provider-specific values from server workflows, Jobs handlers, agents MCP and standard MCP. Remove import-time Firebase initialization from storage-agnostic modules.
2. Enforce zero Firestore Admin imports under application/domain directories, with allowlist only for the adapter's package and auth provider while auth has not yet been extracted.
3. Update Dockerfiles/build packaging, dependency pinning, local dev bootstrap, GH Actions, Terraform deployment variables (if needed), runtime docs and project contributor instructions. Packaging a local dependency must not make the Docker build omit the external adapter.
4. Start with existing production Firestore behind the adapter. Roll out module groups gradually; check real auth, Sessions, Events, MCP, Jobs, Project Manager and background continuation and revert independently if needed.

Exit: all server document persistence flows through @awfl-us/storage. Existing Firestore remains the active provider; no production data copy or schema change.

### Phase 6 — broader AWFL platform neutrality (separate follow-ups)

The **database extraction is only the first dependency boundary**.

- Extract Firebase Authentication and ID token validation into an auth-provider package/interface so the core API is not linked to firebase-admin; retain existing user IDs and tokens until an explicit auth migration. Web AuthProvider and the CLI login flow are separate client migrations.
- Introduce small independent contracts for object/artifact storage (currently GCS), asynchronous task/queue dispatch (Cloud Tasks/Workflows), background compute/exec (GKE, Cloud Run), secrets and event transport (Pub/Sub). Keep them **outside** the one document Storage interface.
- The Scala DSL and compiled Rust workflow protocol should remain ignorant of database, cloud, and identity provider details. The server owns effects, I/O boundaries and trusted execution context.
- Only when there is a real database migration goal, build an alternative storage adapter (e.g. PostgreSQL using Kysely internally), implement subscriptions with durable notifications/change log, match the same contract and plan data migration/rollback separately. No unused second database integration now.

## Testing matrix and acceptance gates

| Test | Required result |
| --- | --- |
| Contract import boundary | @awfl-us/storage imports without firebase-admin or Google SDK; API/Jobs application has no direct Firestore imports after full migration. |
| CRUD and namespace | All document operations, nested collections and scoped paths preserve current production behavior; missing/duplicate errors normalized. |
| Queries | Filters including IN and range; ordered pagination/reverse; projection; collection-group; counts; same observable results as Firestore. |
| Transactions | Atomic create/claim, conflict retry, concurrent leases, owner validation, stale-worker fencing and nested fork ancestor guarantees. |
| Subscriptions | Initial replay, concurrent writes during subscribe, ordered changes, unsubscribe, reconnect and bounded resource usage; SSE/MCP completion not lost. |
| Data compatibility | Existing Firestore records read/write unchanged; timestamps, nested maps, 64-bit-safe integer handling, JSON-encoded native slots and usage increments tested. |
| Runtime | Real Project Manager memory and durable executions, callback wakeups, asynchronous continuation, recovery after worker restart, no unexpected journals. |
| Security | Auth boundaries intact, no privilege escalation via guessed document paths, provider errors fail closed, secrets not logged. |
| Performance | p50/p95 for same workflow and workload measured; per-call interceptor adds negligible local overhead and no new service network round trips. |
| Deployment/rollback | Release install and env selection reproducible; old Firestore adapter path safe to restore without data conversion; Terraform stays source of infra changes. |

## Risks and explicit non-goals

- **Cannot treat Firebase Firestore semantics as universal.** SQL implementation must preserve transaction, query/index and subscribe guarantees or clearly negotiate a new storage contract version, never silently change behavior.
- **Listener delivery is a correctness dependency.** MCP tool completion and SSE event availability are not just UI niceties; reconnect/catch-up and unsubscribe behavior must be specified.
- **Storage abstraction is not an automatic latency fix.** A new in-process function call is cheap, but backend network I/O remains; do not add microservices or proxy Firestore through extra HTTP requests. The timing interface makes total Firestore SDK latency measurable.
- **No data migration or second backend in this effort.** Avoid expanding scope to production database migration, new GKE storage services, rewriting the DSL, or eliminating Firebase Auth before its own migration plan is accepted.
- **Do not alter production execution mode.** The memory-first flag was intentionally enabled in production at the time of this audit; preserve it and test both memory and durable paths.
- **Preserve test-first portability.** Do not call the server portable while any non-provider module still imports the vendor SDK or exposes Firestore-specific return types.
