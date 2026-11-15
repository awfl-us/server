# Managed AWFL native execution-state storage benchmark — November 14, 2026 (ET)

**Status: Completed against all three real managed Google Cloud database services.**

This supersedes the earlier local/emulator-only evidence. The benchmark does **not** imply that the complete AWFL platform storage interface has been migrated or that every production native executor operation is equivalent to this scoped pilot.

## Selection made after the benchmark — November 14, 2026 ET

**PostgreSQL is selected as the AWFL document-storage destination.** Keep the tested **Cloud SQL `db-f1-micro` shared-core** tier and standard disk durability. The observed 488.21 ms p99 for 16 concurrent, independent execution completions is acknowledged but **not a migration blocker or a reason to benchmark/upgrade to a dedicated-core tier now**. Reassess from real workloads and business requirements rather than preemptively raising idle cost. The estimated base of roughly **$10–15/month** is a planning estimate, not an itemized invoice. See the [PostgreSQL implementation plan](postgres-storage-migration-plan.md) and [database-independent storage plan](platform-agnostic-storage-implementation-plan.md).

This is a **backend decision, not a completed production cutover**: the existing Firestore-backed application remains active; the benchmark pilot covered a subset of execution-state operations. RTDB remains benchmark-only; there is no plan to build it into a complete production adapter.

## Executive results

- **1,800 measured execution lifecycles succeeded**, zero failed: 3 databases × 2 concurrency settings × 300 cycles each, with 25 excluded warmup cycles per run.
- **Sequential guarded completion p50 / p95 / p99:** Firestore **45.06 / 78.40 / 170.19 ms**, RTDB **40.49 / 60.79 / 132.11 ms**, PostgreSQL **5.20 / 6.35 / 7.13 ms**.
- **16-worker guarded completion p50 / p95 / p99:** Firestore **83.95 / 206.30 / 280.94 ms**, RTDB **68.08 / 167.46 / 266.21 ms**, PostgreSQL **16.76 / 81.64 / 488.21 ms**.
- Sequential PostgreSQL median guarded completion was **8.7× faster than Firestore** and **7.8× faster than RTDB** for this exact execution-state model.
- **Sequential unguarded write medians:** Firestore **30.49 ms**, RTDB **21.20 ms**, PostgreSQL **1.90 ms**.
- **Managed PostgreSQL correctness:** The separate real Cloud SQL integration test passed, including **16 competing claims on one record**, expired leases, stale epochs, completion and cancellation fencing.
- **Qualification:** PostgreSQL's very small `db-f1-micro` instance had severe concurrency p99 outliers despite its clear median and p95 lead. The 16-worker PostgreSQL completion **p99 488.21 ms** was worse than Firestore's 280.94 ms and RTDB's 266.21 ms. Do not treat it as a hard real-time system.

## Setup and comparability

- **Origin:** The *same* AWFL server lightweight GKE consumer in the `us-central1` area, no separate Jobs deployment. Three databases benchmarked **in separate runs**, not simultaneously, so one provider's test load does not distort another's measurements. Resource sharing and momentary cloud load can still affect p99.
- **Workload:** `create → get → claim owner/epoch/lease → updateMemoryProgress → complete → getCompleted → raw put → raw get`, then cleanup deletes. All eight listed operations are measured separately; cleanup excluded. Real synthetic ~1 KiB input and ~1 KiB completion output. Each cycle has its own execution record; **16 workers act on distinct records**, not one contended row. Claim/complete use the shared `NativeMemoryExecutionPilotStore` and exactly the corresponding `AtomicRecords` adapter.
- **Firestore:** Cloud Firestore `(default)` in **`nam5` multi-region**; Node `@google-cloud/firestore` SDK backed by Google gRPC/GAX, with the injected OAuth user token supplied to `GoogleAuth` (the GKE service account otherwise returns `PERMISSION_DENIED`). Single-document `runTransaction` for guarded changes. The benchmark does not change production collection paths.
- **RTDB:** Dedicated `awfl-native-storage-bench` instance in **`us-central1`**; Node HTTPS `fetch` using the injected OAuth token; conditional ETag `GET` + `PUT` retries for atomic guarded changes. Realtime Database security rules deny all direct client access; benchmark admin OAuth is permitted.
- **PostgreSQL:** Google Cloud SQL **PostgreSQL 15.19**, **Enterprise `db-f1-micro`, ZONAL**, 10 GiB SSD in **`us-central1`**, connected via Cloud SQL Auth Proxy v2.18.3 with automatic IAM database login for `awfl-consumer`; Node `pg` with a persistent pool (2 connections for serial; 16 for parallel). JSONB row state updated inside `BEGIN` / `SELECT ... FOR UPDATE` / `UPDATE` / `COMMIT`. Verified database settings: `synchronous_commit=on`, `fsync=on`, `full_page_writes=on`, `max_connections=25`. No durability toggles were changed.
- **Conditions:** 300 recorded cycles for each provider at concurrency 1 and 16; 25 serial warmup cycles excluded from timings. Timings use Node's `performance.now()` around successful awaited operations. Network, SDK, transport and proxy cost *are included*. Connection creation and first auth/handshake excluded by warmup. Results are sampled once, not repeat-night averages.
- **Important:** Firestore `nam5` offers multi-region replication whereas the other two services are regional. They do not provide identical availability, failure recovery or transaction/consistency guarantees; compare this *specific* single-record storage workload, not all database features.

The figures in both detailed tables are in **milliseconds** and each cell is **p50 / p95 / p99**, computed over 300 successful samples.

## Sequential, one worker

| Operation | Firestore `nam5` | Realtime Database | Cloud SQL PostgreSQL |
|---|---:|---:|---:|
| `state.create` | 33.89 / 47.11 / 67.06 | 22.16 / 37.42 / 72.18 | 2.11 / 2.72 / 2.95 |
| `state.get` | 11.46 / 18.79 / 31.40 | 18.49 / 33.31 / 158.23 | 1.24 / 1.78 / 2.20 |
| `state.claim` | 44.29 / 67.30 / 145.39 | 40.53 / 59.81 / 80.46 | 4.93 / 6.20 / 11.74 |
| `state.progress` | 43.93 / 64.83 / 127.92 | 40.72 / 60.53 / 90.32 | 5.04 / 6.18 / 6.91 |
| `state.complete` | 45.06 / 78.40 / 170.19 | 40.49 / 60.79 / 132.11 | 5.20 / 6.35 / 7.13 |
| `state.getCompleted` | 11.44 / 18.54 / 25.77 | 18.56 / 37.30 / 125.97 | 1.26 / 1.96 / 2.09 |
| `raw.put` | 30.49 / 45.41 / 99.84 | 21.20 / 32.11 / 58.72 | 1.90 / 2.39 / 2.56 |
| `raw.get` | 11.39 / 19.71 / 39.86 | 18.20 / 31.00 / 43.65 | 1.16 / 1.73 / 1.94 |

## Concurrent, 16 workers

| Operation | Firestore `nam5` | Realtime Database | Cloud SQL PostgreSQL |
|---|---:|---:|---:|
| `state.create` | 54.57 / 132.35 / 187.54 | 30.54 / 138.63 / 240.38 | 5.74 / 390.78 / 539.08 |
| `state.get` | 19.39 / 89.71 / 116.80 | 27.65 / 84.10 / 122.70 | 3.32 / 50.65 / 69.04 |
| `state.claim` | 86.44 / 211.25 / 281.93 | 69.82 / 207.05 / 273.33 | 16.42 / 79.64 / 202.61 |
| `state.progress` | 88.74 / 226.64 / 281.56 | 69.55 / 175.35 / 327.15 | 17.17 / 79.65 / 149.26 |
| `state.complete` | 83.95 / 206.30 / 280.94 | 68.08 / 167.46 / 266.21 | 16.76 / 81.64 / 488.21 |
| `state.getCompleted` | 19.91 / 107.50 / 190.22 | 30.38 / 97.61 / 199.68 | 3.47 / 49.51 / 63.80 |
| `raw.put` | 42.64 / 109.11 / 136.43 | 31.57 / 77.28 / 98.57 | 5.47 / 56.16 / 71.15 |
| `raw.get` | 18.36 / 87.14 / 103.69 | 26.73 / 81.19 / 130.88 | 2.84 / 49.64 / 61.45 |

## Interpretation

1. **PostgreSQL wins on the central latency goal** for single-record execution-state mutations. The generic transactional design achieves about **5 ms median guarded completion** and about **2 ms median raw write** on a cheap, real managed instance, with normal synchronous commit enabled.
2. **Realtime Database helps, but not enough.** RTDB is 21.20 ms for a plain write and 40.49 ms for guarded completion median, despite being regional. Its ETag-based atomic mutation consumes at least a read and conditional write, plus possible retries. A raw write comparison alone would understate AWFL's real cost.
3. **Firestore's current design/region are expensive for this path.** The single document, transactional completion p50 is 45.06 ms; its ordinary write p50 is 30.49 ms. We should not infer that transaction/SDK restructuring can consistently get multi-region Firestore below 5 ms.
4. **PostgreSQL's high-concurrency p99 is accepted at present scale.** The tiny shared-core tier has 25 maximum SQL connections, and 16 simultaneous execution lifecycles can produce isolated stalls. Potential causes include CPU, WAL fsync, proxy/network, pool scheduling and shared infrastructure contention. Keep bounded pools and basic monitoring. **Do not make dedicated-core benchmarking or upgrading a prerequisite**; investigate only when actual traffic or service expectations require it.
5. **No wholesale backend switch yet.** Full `Storage` requires queries, cross-record transactions and subscriptions. Postgres needs an implementation strategy for realtime subscriptions (e.g., `LISTEN` / `NOTIFY` with backfill and replay guarantees). Firestore and RTDB correctness tests for cancellation, conflicting claims, and replay were separate; these 16-worker performance runs use independent execution IDs and do not substitute for contention correctness tests.

## Source data / reproduction

The six raw JSON files are checked in alongside this report in [`benchmarks/storage-managed-2026-11-14`](benchmarks/storage-managed-2026-11-14/). Each contains per-operation n, error count, p50/p90/p95/p99, min/max, warmup size, concurrency and total duration; no credentials, customer data, or tokens are included.

Use `scripts/benchmarks/storagePilot.mjs` with the matching backend and `--runs=300 --warmup=25 --concurrency=1` or `--concurrency=16`. Set `GOOGLE_ACCESS_TOKEN_FILE` to the injected user OAuth token path for Firestore/RTDB, `RTDB_DATABASE_URL` to the Terraform output, and run Cloud SQL Proxy with `--auto-iam-authn` on localhost plus `PGHOST`, `PGPORT`, `PGUSER` and `PGDATABASE`. The benchmark tool creates synthetic records under isolated paths and cleans them on completion. Never commit OAuth tokens.

**Costs:** The Cloud SQL `db-f1-micro` benchmark instance is still running and billed at its small always-on rate (~$10–15/month plus any extra charges). RTDB has no comparable provisioned compute idle charge. Retain or destroy the dedicated benchmark resources through `infra/storage-benchmark` Terraform when investigation is complete.
