# Project Manager: Firestore vs PostgreSQL adapter comparison — November 16, 2026

**Scope:** Experimental native-memory-root document Storage only. This is not a production-wide database cutover or a full LLM-driven Project Manager benchmark.

## Environment and implementation

- Origin: existing AWFL GKE consumer in `us-central1` with a persistent Node process.
- Firestore: managed `(default)` Firestore in `nam5`, authenticated by the injected user OAuth token through the Firestore SDK.
- PostgreSQL: managed Cloud SQL 15 `awfl-native-storage-bench`, zonal `db-f1-micro` in `us-central1`, through Cloud SQL Auth Proxy with automatic IAM authentication.
- Same server implementation `createNativeMemoryStore({env:{AWFL_DOCUMENT_STORAGE_BACKEND}, firestoreDb, postgresPool})` for each backend, using `DocumentAtomicRecords` and `NativeMemoryExecutionPilotStore`.
- Project Manager binary: the actual published IAM-verified native release `codebase-ProjectManager`, SHA256 `06c7cdc3bf7e87959ae1b2243d205fb29414a24516f3c7a9ec040956aad4b9c8`, `parallelVersion=1`, `streamIpcVersion=1`.
- Test seed: input and completed result from an existing authorized, successful Project Manager execution. Original data and replay fixtures stayed in private mode-0600 GKE files, **not committed**. Each measured test created and deleted random temporary execution records; the original was never modified.

The migrated portion is **only native memory-root execution state**: create, claim/fencing, progress, completion/failure/cancellation, status and readback. The background/durable journal, callbacks, context, tool registry, Jobs-facing `/firebase/*` operations and SSE events still have other provider-specific paths. Firebase Auth is also unchanged.

## Test A: real published Project Manager binary (bounded replay)

The actual native Rust Project Manager and published child releases ran through `runNativeMemoryWorkflow` using each real backing store and the same recorded Jobs effect outputs. Project Manager registered its execution, updated status, acquired a session lock, emitted events, entered `native.parallel`, and forked into `codebase-ProjectManager-prompts` and `codebase-ProjectManager-tools`. Those children invoked deeper local workflows.

A replay fixture was incomplete for nested child operations. Known no-agent-mapping and empty-default-tools routes were emulated with the **documented route behavior**; the trial then reached `tools-CliTools` `callback.create`, for which no local replay handler existed. **Both databases persisted a terminal failure with the same error `operation not allowed in local native workflow`. These are expected harness failures, not successful Project Manager completions.** The run exercised about 14–16 native effects, depending on fork cancellation/interleaving; it is not a matched complete-workflow comparison.

Five warmed runs per provider, alternating order (one initial excluded warmup), selected median timings in milliseconds:

| Operation | Firestore p50 | PostgreSQL p50 |
| --- | ---: | ---: |
| Native root create | 53.67 | **3.98** |
| Native worker claim | 93.08 | **9.02** |
| Terminal failure persistence | 91.41 | **8.89** |
| Terminal state readback | 34.88 | **2.62** |
| Partial Rust worker replay until harness boundary | 582.80 | 356.87 |

All five runs per backend terminated at the same unsupported-effect class and cleaned their test execution record. **Do not use the last row to claim end-to-end agent speedup:** model calls were replayed, one branch occasionally reached a different effect count, and both executions failed at the test-harness callback boundary.

## Test B: successful Project Manager-shaped storage lifecycle

To measure the storage portion through actual **success**, the exact recorded Project Manager input, native release metadata and completed output were passed through the same native memory-root stores. Each measured cycle performed:

1. `create` with original PM metadata/input.
2. `claim` with owner and lease fencing.
3. `updateMemoryProgress` with PM effect count.
4. `complete` with the original PM result.
5. `get` and verify completed status, effect count and deep-equal result.
6. Second worker `claim` verifies terminal idempotency, then delete temporary record.

These are **database-state lifecycle tests**, not reexecutions of an LLM session. One warmup per backend was excluded, with **12 sequential successful cycles** and **8 + 8 concurrent independent cycles** per backend; no failures.

### Sequential (first run; 12 measured cycles/provider)

| Operation | Firestore p50 | PostgreSQL p50 |
| --- | ---: | ---: |
| Create | 55.18 ms | **2.97 ms** |
| Claim | 65.34 | **7.27** |
| Progress | 71.05 | **7.39** |
| Complete | 86.46 | **7.55** |
| Readback | 32.06 | **1.97** |
| Entire tested cycle including idempotent claim and cleanup | 480.14 | **37.39** |

End-to-end tested-cycle p95: Firestore **751.69 ms**, PostgreSQL **48.56 ms**. PostgreSQL first-run median was **12.8× faster**. A second independent sequential run of 12 each measured Firestore **357.73 ms** vs PostgreSQL **41.26 ms** p50, confirming a sizeable gap with load variability.

### Eight independent concurrent execution roots (repeated warm-pool burst)

| Metric | Firestore | PostgreSQL |
| --- | ---: | ---: |
| Successful / attempted | 8 / 8 | 8 / 8 |
| Cycle p50 | 370.18 ms | **62.72 ms** |
| Cycle p95 | 558.71 ms | **66.53 ms** |
| Complete operation p50 | 52.59 ms | **16.33 ms** |

PostgreSQL was **5.9× faster** at median tested-cycle latency after warming its pool. The initial eight-worker burst on a fresh PostgreSQL pool yielded **229.36 ms p50** (much slower than subsequent 62.72 ms); it opened additional SQL connections. This is important for resource planning on the 25-connection Cloud SQL instance: warm/bound the pool appropriately and don't treat first-burst connection setup as steady-state transaction latency.

## Correctness and remaining gap

- Existing real-backend `test/storage/nativeComposition.integration.test.mjs` passed **2/2** (real Firestore and real PostgreSQL). It tests competing claims, progress, cancellation and stale completion.
- The two Project Manager-shaped successful lifecycle benchmarks each passed with **all state results matching** and all temporary records cleaned.
- Actual published Project Manager Rust execution reached the same nested callback integration gap on both providers. Full PM execution, recursive durable journals/detached scheduling, callbacks, SSE, HTTP API storage and LLM latency have **not** been compared end-to-end under both backends.
- Therefore a full application routing switch remains out of scope; Firebase remains authoritative for production.

## Reproduction notes

The isolated developer commands used real Cloud SQL Auth Proxy and injected user OAuth credentials, without committing tokens. Test data was read from an already-authorized Project Manager execution and held in untracked private GKE files. Script names used for this ad-hoc comparison: `pm-export.mjs` (read-only export), `pm-adapter-compare.mjs` (actual Rust partial replay), `pm-state-lifecycle.mjs` (real DB complete-state lifecycle). They are intentionally **not** checked in because they refer to private execution fixtures; this document contains only non-sensitive aggregate metrics.

The next functional milestone is to route Project Manager's remaining Jobs/document/callback dependencies through the provider-neutral storage boundary and run a fresh authenticated Project Manager request against both complete backend paths. Do not interpret lower root-state latency as an equivalent reduction in total LLM-dependent user response time.
