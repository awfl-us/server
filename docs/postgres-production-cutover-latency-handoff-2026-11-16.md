# PostgreSQL production cutover and latency investigation — session handoff

**Status:** November 16, 2026 (Eastern). **Next priority:** finish and deploy the PostgreSQL data-plane cutover, **then** investigate the remaining end-to-end execution latency with complete instrumentation. **Production is still on Firestore.** Do not mistake a local experiment for production deployment.

This is the current operational handoff; detailed design remains in [PostgreSQL migration plan](postgres-storage-migration-plan.md), [Jobs migration status](jobs-document-storage-migration.md), [platform-agnostic storage plan](platform-agnostic-storage-implementation-plan.md), and [scoped-stream benchmark](postgres-scoped-streams-benchmark-2026-11-16.md).

## Verified implementation state

- The **`feat/jobs-document-storage-provider` branch** migrates Jobs' document-persistence routes and shared modules to `storage/service.js` / the provider-neutral `Storage` contract. `AWFL_DOCUMENT_STORAGE_BACKEND` chooses `firestore` (default) or `postgres`. The branch includes the Firestore and PostgreSQL adapters, native **memory-mode** state composition, callback Storage support, and Jobs integration tests. This is **not deployed as the production provider**.
- Migrated Jobs areas: `/firebase/*` CRUD/list/locks, execution status/linking, agents/session mappings, tool definitions, task records, context/YOJ and collapsed groups, events/SSE and session/project subscriptions, project/workspace locks, callback registration, LLM credentials and usage, history restoration, producer/consumer coordination and OAuth integration persistence. See the Jobs migration document for details and remaining test cases.
- **Not fully switched:** legacy **durable** native executor (`NativeExecutionStore`, effect journals/recovery) and **MCP control-plane** workspaces/requests still use Firestore-specific transactions. Firebase **Auth** is a separate dependency and may remain. The API and persistent GKE consumer need provider-consistent composition and compatibility verification. Do not claim a Firestore-free system yet.
- PostgreSQL on managed Cloud SQL 15 `db-f1-micro` has been tested through Cloud SQL Auth Proxy with IAM auth. Existing benchmark instance: `awfl-us:us-central1:awfl-native-storage-bench`, database `awfl_bench`; Terraform ownership currently under `infra/storage-benchmark`. Do **not** assume a benchmark database is suitable for production without deciding its retention, backup and IAM configuration.
- Scoped event-stream implementation removed the prior **global cursor row** that serialized unrelated PostgreSQL writes. Generic subscriptions are state watches; durable per-session/project events use explicit `appendEvent/replayEvents/subscribeEvents`. The production event replay/reconnect behavior must be verified before cutover.
- Functional local Rust Project Manager completed with `BENCH_OK`, **59 effects** each on both backends. Two CLI callbacks were handled. **Three detached maintenance children failed** on both backends; previously observed `unsupported subtraction operand types` in Rust, not evidence of a PostgreSQL regression. Check and fix separately.

## Actual measured results

These are **local AWFL compiled-Rust/Jobs** tests with real managed databases, not production A/B tests. The local test process alternated the Jobs process' `AWFL_DOCUMENT_STORAGE_BACKEND` *and* the native memory-store backend. The same published `codebase-ProjectManager` artifact was used, with local Jobs HTTP handlers and real external effects. A test-only local CLI callback bridge delivered native callbacks. It is not the normal production session launcher. Each workflow had 59 effects.

| Metric | PostgreSQL | Firestore |
| --- | ---: | ---: |
| Completed main workflow runs | 3 | 3 |
| End-to-end times, seconds | 14.07, 10.18, 22.38 | 14.70, 12.00, 19.80 |
| Median end-to-end, seconds | **14.07** | **14.70** |
| Cumulative **native execution-state** Storage times, milliseconds | 313.93, ~229, ~649 | 2810.77, ~2091, ~4192 |
| Median native execution-state Storage time, milliseconds | **313.93** | **2810.77** |
| Median native-store cumulative speedup | **~9.0×** | baseline |
| First paired run, 26 Jobs HTTP POST effects, cumulative | 2384.33 ms | 6044.58 ms |
| First paired run, two callback awaits, cumulative | 7575.22 ms | 5647.48 ms |

**Measurement boundary:** the `storeTimed` proxy in the local runner counts only native execution-state `create/claim/updateMemoryProgress/complete/get` operations. It does **not** count every `get/put/query/transaction/subscribe` inside Jobs. The Jobs HTTP timings **include** route logic, HTTP transport, authentication, and database calls, so **do not label** the POST timings as database-only or add their totals directly to native-store timings. Cumulative timings can overlap across concurrency. The six results are too few to infer a reliable end-to-end speedup.

Four more runs completed during a ten-run attempted batch, but the GKE consumer terminated during run five; the replacement consumer also failed. Completed measurements were saved before the interruption. This is **not** a five-run success. A separate earlier production Firestore Project Manager run completed in **56.82 s** with 59 effects, but its **deployment path differs** from these local runs and is **not** an apples-to-apples PostgreSQL comparison. Its existing native trace showed roughly 1.17 s of measured execution-state work, 8.15 s Jobs HTTP effects, 5.44 s GCS materialization, and 0.68 s native transitions (overlapping cumulative operation time).

The original November 14 managed single-record pilot completed 1,800 lifecycles and measured guarded completion p50 5.20 ms PostgreSQL vs 45.06 ms Firestore; the broader November 16 Jobs/Project Manager exercise must be interpreted separately.

## Next session — execute in this order

### Phase 1 — finish PostgreSQL production cutover

1. **Inspect actual branch vs `main`, CI and open PRs.** The Jobs provider migration branch exists; it may diverge from main. Integrate the code, resolve conflicts and run the existing Storage/Jobs tests, including live Firestore and managed PostgreSQL. Check the recent scoped-event implementation/migration is present and matches schema and deployed code. Do not replace code with a synthetic benchmark harness.
2. **Inventory residual Firestore persistence outside the migrated Jobs routes.** In particular: the API's client-auth/credential and stored records, MCP/Agents MCP control-plane workspaces and commands, legacy durable native execution/recovery, GKE consumer state, event replay and callbacks. Decide explicitly for each whether to convert now or retain as a documented *separate* Firestore control plane. The selected provider **must** be consistent for every part of one root execution, including callbacks/children/status.
3. **Choose production Cloud SQL configuration using Terraform only.** Evaluate promotion of the existing benchmark instance versus a separate prod database/role; preserve Terraform state, data and the separate GCS buckets. Set up IAM database auth/Cloud SQL connector, migrations, small bounded connection pools across API/Jobs/GKE (instance measured `max_connections=25`), backups, recovery and credentials from Secret Manager. No manual infra drift or plaintext passwords.
4. **Inspect Firestore data and migrate the state worth preserving** (users/projects, sessions/history, integrations/credentials, tool definitions, tasks, events/cursors, callbacks, usage, execution links). Use a one-time export/import with deterministic paths, normalized Timestamp/field values, record counts/checksums, and a clear plan for active executions (drain or migrate *by root*). There are currently no paying customers, so avoid an elaborate ongoing dual-write system.
5. **Configure API, Jobs, and persistent worker consistently** with `AWFL_DOCUMENT_STORAGE_BACKEND=postgres`, database connection settings, `AWFL_NATIVE_DOCUMENT_STORE_ENABLED=1` where using native memory mode, and existing Rust/Jobs flags; be explicit if any legacy durable or control-plane scope intentionally remains Firestore. Terraform and standard CI/CD own rollout. Do not inadvertently disable Firebase Auth.
6. **Run normal, authenticated, end-to-end checks** with the production execution route: create/resume Project Manager session, read/write messages and tasks, CLI callbacks, tool definitions, nested compiled workflows, event SSE replay/reconnect and cancellation, user scoping, and worker restart/claim fencing. Confirm document records and native memory executions are actually in PostgreSQL; check no data plane writes go to Firestore. Monitor Cloud SQL pool exhaustion, query failures, SERIALIZABLE retries, and connection saturation.
7. **Verify production cutover and preserve a rollback path.** Check actual service revisions/env vars and generated workflows, data counts and representative session histories, active executions and callback delivery. Retain Firestore backups/adapter temporarily. Avoid flipping in-flight roots between backends. Only claim full cutover for scopes that demonstrably use PostgreSQL.

**Phase 1 exit:** production Jobs and native memory-mode execution data plane use PostgreSQL consistently with validated session/event/callback behavior; remaining intentional Firestore-only areas are itemized, or migrated if in scope. No hidden new Firestore reads/writes on the migrated path.

### Phase 2 — investigate remaining execution latency in detail

**Begin after verifying the PostgreSQL production cutover.** Work with ordinary Project Manager executions and existing tracing, not a simulated orchestration harness.

1. Add **provider-neutral Storage instrumentation at the single `Storage` interface boundary** across Jobs, API, and workers. Measure every `get/create/put/update/delete/query/count/listCollections/batch/transaction/subscribe` call, including transaction retries and SQL pool acquisition. Group by selected provider, route/operation, service, execution/session ID, and outcome; exclude private document content, credentials and raw sensitive IDs. Track counts, cumulative time, p50/p95/p99, longest calls, overlapping concurrency, and critical path. Distinguish transaction total time from underlying SQL queries; avoid double-counting nested operations.
2. Instrument **HTTP effects by endpoint and both sides**: workflow HTTP dispatch vs Jobs request handling, auth/OIDC token acquisition and verification, request routing, Storage time, data mapping/serialization and response. Previous grouped `http.post` timing (2.38 vs 6.04 seconds over 26 POSTs) is **not** a database breakdown. Measure the `/firebase/*`, `/events`, `/agents`, `/tasks`, `/context`, `/callbacks` and `/producer` hot paths individually.
3. Capture the rest of the end-to-end critical path: LLM round-trip (model/network/token generation), two CLI callback lifecycles (delivery/consumer queue + Python process startup + tool execution + wake), GCS artifact release lookup/materialization/caching, Rust transition/resume/child fork/join, per-step workflow launch/IPC, Cloud Tasks or dispatcher overhead, and Cloud Run/GKE startup/queuing. Timing categories can overlap; report actual wall-clock stages and separately summed work.
4. Repeat **ordinary comparable production executions** after cutover (same model, prompt, artifact, user/project route and warm/cold state); collect several runs and p50/p95, plus per-execution waterfall/traces. A baseline Firestore production run exists but is not comparable to local PostgreSQL timings. If needed, run a small separate Firestore canary with the **same deployment path**; don't flip a live production session between databases.
5. Rank latency contributors by critical-path milliseconds and effort. Fix the few highest-impact operations first, re-run, and attach before/after traces. Specific hypotheses: repeated Jobs HTTP hops; GCS materialization (~5.44 s cumulative in one production Firestore run); callback/CLI wakeups (~5–8 s cumulative in local runs); auth overhead, redundant context/history reads, SQL query/pool waits, and unnecessary synchronous storage or serialization. Validate rather than asserting these are causes.
6. Investigate the **three detached Rust maintenance-child failures** (`unsupported subtraction operand types`) independently; validate parent execution and children so benchmarking is not masking a functional regression.

**Phase 2 exit:** a documented per-run latency waterfall with every major Jobs DB operation attributed, p50/p95 over comparable normal executions, top bottlenecks prioritized, and before/after numbers for each fix.

## Current limitations / do not repeat

- Do not describe the native-store `~9×` number as **all Jobs DB calls**. No comprehensive Jobs Storage timing existed in the captured local runs.
- Do not claim production PostgreSQL deployment or main-branch migration until verified.
- Do not compare the 56.82-second production Firestore run directly against a ~14-second local PostgreSQL run.
- Do not spend time on a new synthetic harness; run the actual local Jobs/server or ordinary production launcher.
- Keep infra in Terraform, Firebase Auth separate from storage, and state provider selection consistent.
