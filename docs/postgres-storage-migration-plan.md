# PostgreSQL storage migration — implementation plan

**Decision:** November 14, 2026 ET. **Selected provider:** PostgreSQL 15 on the existing Cloud SQL **`db-f1-micro` shared-core**, `us-central1`, 10 GiB SSD. **State:** M0 adapter foundation has started (provider-neutral document contract, PostgreSQL JSONB implementation, transactions, change log/subscriptions and real managed integration tests); application routing and Firestore data migration remain pending. The production AWFL server continues to use Firestore.

This is the executable next-step plan under [platform-agnostic storage](platform-agnostic-storage-implementation-plan.md). Keep code moving through small local-test/commit increments; do not spend another cycle comparing database tiers or waiting for deployments. No paying customers currently, but developer/user-owned state can still exist and should not be destroyed without inspection.

## Evidence and scope

The [real managed three-backend benchmark](storage-pilot-managed-three-backend-benchmark-2026-11-14.md) completed **1,800 successful execution lifecycles, no failures**, with 300 samples per backend per concurrency level (1 and 16). For an equivalent fenced execution completion, PostgreSQL was **5.20 ms p50 / 6.35 ms p95** sequentially versus Firestore **45.06 / 78.40 ms** and RTDB **40.49 / 60.79 ms**. At 16 independent workers, PostgreSQL was **16.76 ms p50 / 81.64 ms p95**, Firestore **83.95 / 206.30**, RTDB **68.08 / 167.46**. PostgreSQL p99 was **488.21 ms at 16 workers**; we explicitly accept it at the present scale. SQL had `synchronous_commit=on`, `fsync=on`, and a measured `max_connections=25`. Six raw JSON outputs are [committed](benchmarks/storage-managed-2026-11-14/).

The pilot proved only **single-record** operations (`storage/pilot/`); do not claim that it implements the production document API, nested fork ancestry, queries, multi-record transactions, or durable subscriptions.

## Target architecture

- **One provider-neutral document `Storage` interface**, covering CRUD, collections, filtered/ordered queries, pagination, counts, field transforms, batch, multi-record transactions, and document/query subscriptions. Keep it independent of Firebase, SQL, GCP, HTTP and the Rust runtime. Define typed results, errors and monotonic instrumentation; a single Storage object offers subscriptions as well as writes. Keep the entire hot path in-process; never add a database microservice.
- **PostgreSQL adapter** (`@awfl-us/storage-postgres` is the intended package name), using `pg` and parameterized SQL. The driver owns schema migrations, connection pools, JSONB serialization, indexes, transaction semantics, and watch implementation. **Firestore adapter** remains only for existing data/compatibility and independent contract tests. The experimental RTDB adapter can remain in the benchmark folder; do not expand it into a full platform driver.
- **Provider construction at composition roots** of API, Jobs and GKE worker processes; no `getFirestore()` or Google SDK types in the application/business modules after conversion. Firebase **Authentication stays in place** as a separate identity dependency. Preserve current service/API/compiled-workflow contracts during the database move.
- **One database of truth per execution and operation.** The backend used to create a root must be used for its claims, progress, callbacks, children, completion and readback. Do not route individual writes randomly or dual-write transactions to Firestore and Postgres.

### PostgreSQL data model (proposed, to verify against call sites)

Use a path-preserving document table initially to minimize code changes, with typed/indexed projections only where necessary:

```sql
CREATE TABLE storage_documents (
  path text PRIMARY KEY,
  collection_path text NOT NULL,
  collection_id text NOT NULL,
  document_id text NOT NULL,
  data jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX storage_docs_collection ON storage_documents(collection_path, document_id);
CREATE INDEX storage_docs_collection_group ON storage_documents(collection_id, path);
```

These are **design sketches, not deployed DDL**. Path hierarchy, collection-group handling, query ordering and subcollections need exact contract tests. Validate every component of a document path; create explicit indexes for actual `where` + `orderBy` queries. Never implement production collection queries by loading an entire table into JS to filter. Include deterministic document-ID tie-breaking for pagination. Use portable typed query/patch operations, not raw SQL in callers; normalize Firestore timestamps, missing/null, `FieldValue.increment`, and 64-bit values at the adapter boundary. Consider an execution-state table or focused columns for hot owner/epoch/lease/status updates **after** the initial parity work, allowing one conditional `UPDATE ... WHERE ... RETURNING` without serializing a large JSON document. Do not sacrifice correctness to hit a latency number.

### Transactions, subscriptions and wakeups

- One SQL transaction owns all reads and conditional writes for a logical operation. Use row locks/conditional updates for owner and epoch fencing, atomic create, cancellation and terminal-state conflict. Multi-document ancestor/fork checks and effect-journal mutations must be in the **same SQL transaction** where required. Test two workers racing and parent cancellation racing a child completion.
- `LISTEN`/`NOTIFY` is a **wakeup signal, not durable event storage**. For callbacks, MCP command outputs, events and query subscriptions, persist a scoped, transactional change log with a monotonic **commit-safe cursor** and enough information to replay changes after reconnect. Notifications carry only a key/cursor; never sensitive document contents. Prefer per-project/per-session streams when practical to avoid a single globally contended row. **Postgres sequences alone do not provide commit ordering**: define transactional cursor allocation/locking and test it. Couple snapshot, subscription readiness, replay and live events so the subscribe/read race cannot lose a terminal event. Reconnect by reading the durable log, not trusting notifications alone. Cleanup, retention and bounded subscriber connections are required.
- Keep a **bounded pool** for `db-f1-micro`: measured maximum is **25 server connections**. Budget connections across Cloud Run API/Jobs, GKE worker processes, maintenance and any notification listeners; start with small per-process pools, measure contention and avoid creating one connection per session. Cloud SQL Auth Proxy or connector provides IAM-authenticated access; no stored SQL passwords.

## Implementation order

### M0 — inventory and contract foundation (in progress)

1. Refresh the server's direct and injected Firestore-call inventory (native store, jobs, callbacks, sessions, context/history, projects/tasks, usage, events/SSE, MCP/Agents MCP, background recovery). Mark transactions, listener/query semantics, exact indexes and request scoping by path. Keep the inventory checked in.
2. Stabilize the SDK-independent `Storage` contract and executable test suite. Start with `storage/pilot/` semantics; extend to query, atomic batch, transaction and document/query subscriptions. Define API errors and value codecs before translating endpoints.
3. Establish the **Postgres implementation package boundary**. During fast iteration this can be an in-repo workspace package, with extraction/publishing to `awfl-us/storage` and `awfl-us/storage-postgres` when stable; preserve separate dependencies and import rules from day one. Do not add a new HTTP hop or make package publishing a blocker.

**Current checkpoint:** `storage/document/{contract,atomicRecords}.js`, `storage/postgres/{storage.js,schema.sql,README.md}` and `test/storage/{documentContract,postgresDocuments.integration}.test.mjs` now provide a provider-neutral interface with **real managed PostgreSQL** tests for single-record CRUD, queries, atomic batch, concurrent counters, subscription replay and native memory ownership fencing. The adapter is not wired into production. Remaining M0 gate: exhaustive Firestore call-site inventory and full production query/watch/codec conformance. See [adapter limitations and test commands](../storage/postgres/README.md).

**Exit:** common tests pass with a real PostgreSQL database; code outside the adapter can import the contract without importing Firebase/SQL SDKs. Do not call M0 complete until all required application semantics have been inventoried.

### M1 — native memory-root execution state (first functional integration)

1. Take the measured pilot `PostgresAtomicRecords` and `NativeMemoryExecutionPilotStore` and connect them to **real** native memory-root creation, claim, progress, complete/fail, cancel and read routes, not just a synthetic benchmark or optional unused injection. Integrate at the native Jobs composition root and existing execution routing; use the same backend for creation and all later worker operations.
2. Preserve project/user auth scope, owner/epoch/lease expiration, status transitions, result/feedback shapes, terminal immutability and cancellation semantics. Keep the existing memory executor's background/nonblocking persistence behavior, avoid adding synchronous journals, and run actual compiled Rust workflow(s) end to end.
3. Test 16 racing claims on the *same* execution record, stale owner rejection, crash/reclaim, cancel-vs-complete, duplicate create, missing/mismatched ID and resumed readback. The separately tested managed PostgreSQL ownership test is a baseline, not a replacement for real workflow integration.

**Exit:** a real native memory-mode workflow runs through PostgreSQL end to end; no part of the same execution silently reads/writes Firestore.

### M2 — durable execution state, journals and callbacks

1. Port `NativeExecutionStore` durable effects, parent-child relationships, fork/join ancestry checks and restart/replay to the same SQL transaction boundary, preserving the compiler protocol and existing cached-effect/idempotency behavior.
2. Migrate callback creation/await, cancellation and detached execution scheduling to the shared transaction/watch guarantees. Verify no lost callback, no duplicate effect, no stuck claim after crash.
3. Repeat end-to-end tests with compiled Project Manager and representative fork/parallel workflows. Measure SQL commit and side effects separately from LLM/HTTP/GCS to verify that the chosen database remains on the critical path only when necessary.

**Exit:** both memory and durable root/child execution paths have parity, using the same selected backend.

### M3 — general document API, queries, events and subscriptions

1. Migrate simple project/user/task/agent CRUD and the Jobs `/firebase/*` compatibility endpoint **implementation** without changing its public protocol. Translate counters, range queries, projections, reversed pagination, collection-group usage queries, nested collection listing and documented Firestore indexes into tested SQL queries/indexes.
2. Port SSE event writes/replay, context/history, MCP and Agents MCP, command-output watches, callbacks, subscriptions and reconnects. Test initial snapshot + concurrent writes + unsubscribe + reconnect, including another process publishing the terminal update.
3. Remove remaining direct Firestore persistence imports from domain modules. Keep Firebase Admin Auth separately; compose one shared Storage per process. Include contract/lint check preventing new persistence SDK imports outside adapters.

**Exit:** the API, Jobs, MCP, native workflow and event persistence features have the same observable behavior on Postgres and no app-level Firestore DB coupling.

### M4 — data inspection, one-time cutover, and Terraform ownership

1. Inspect what actual Firestore state exists (projects, account records, sessions/history, workflow runs, callbacks and in-flight executions). There are no paying customers, so use a **simple finite one-time migration**, not a permanent dual-write or expensive replication system. Preserve records still needed for development; document counts and data types.
2. Create the destination schema, namespace and indexes via migration files. The existing `awfl-native-storage-bench` instance currently lives under `infra/storage-benchmark` Terraform. Decide whether to promote that *same* instance or create the destination database/roles within it; migrate Terraform state/resources deliberately, not by deleting the stack or renaming the instance blindly. Do not touch the separate GCS object storage and Rust artifact buckets.
3. Migrate only state worth keeping with deterministic path/ID mapping and reconciliation (counts and sampled hashes), or explicitly archive/reset test-only state. Drain or migrate in-flight execution records *atomically by root*, including active leases/children/callback refs; route new roots entirely to PostgreSQL. Verify authentication, session retrieval and Project Manager after the switch.
4. Keep the Firestore adapter and old backup available until verification. Backups/recovery must be decided before storing irreplaceable data: the benchmark database currently has backups disabled and a zonal shared-core instance has no HA/SLA. That is acceptable for an experimental project but not a guarantee of recovery. Config and Terraform are the only infrastructure source of truth.

**Exit:** newly created and retained AWFL document data lives in PostgreSQL; no required running feature still writes Firestore. Then remove unused RTDB benchmark resources and Firestore DB usage through Terraform where appropriate, without destroying the chosen SQL instance.

## Performance and acceptance

- **Do not gate on a dedicated-core retest or on the observed 488 ms p99 outlier.** Keep `db-f1-micro` until measured usage requires a change; target comparable sequential p50/p95 and no dramatic regressions for real workflow critical sections, with normal SQL durability on.
- Contract and integration correctness remain mandatory: multi-record atomicity, real subscriptions and replay, strong scope isolation, stale-worker fencing, preserving cached/replay semantics and no missed terminal events.
- Do not equate a generic JSONB CRUD adapter with full Firestore query compatibility. Only mark a module converted after its required operations and indexes are implemented and tested on **real PostgreSQL**.
- **No deployment gatekeeping during development**: develop/test/commit increments quickly, then let standard CI/CD run. Verify critical state routing before the actual database cutover, but don't wait for every deploy to finish between documentation/code commits.
- Monitor monthly Cloud SQL cost and 25-connection saturation; aim to fund recurring infrastructure from paid managed AWFL usage within a year. Product monetization is outside this migration's scope and should not lead to unrelated platform rewrites.

## Existing evidence / implementation

- Source: `storage/pilot/contract.js`, `storage/pilot/memoryExecutionState.js`, `storage/pilot/adapters/postgres.js`, `test/storage/`, `scripts/benchmarks/storagePilot.mjs`.
- Terraform: `infra/storage-benchmark/` — live real PostgreSQL 15 `db-f1-micro` and RTDB experiment, state stored in GCS.
- Verified managed six-way benchmark: [report](storage-pilot-managed-three-backend-benchmark-2026-11-14.md) and [raw JSON](benchmarks/storage-managed-2026-11-14/).
- Existing platform design/audit: [platform-agnostic storage plan](platform-agnostic-storage-implementation-plan.md).
