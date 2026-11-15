# AWFL native execution storage: three-backend local comparison

**Measured:** November 14, 2026 (ET; November 15 UTC) in the AWFL server's GKE lightweight development consumer. This is **not a managed Google Cloud comparison**; all database connections used loopback within the development pod. Do not use the numbers to promise Cloud SQL, Firestore or RTDB production tail latency.

## Environment and workload

- Firestore **emulator v1.22.0** accessed through the real Firebase Admin Node SDK, and Realtime Database **emulator v4.11.2** accessed through the pilot REST ETag CAS adapter. Both emulators ran as local Java 21 processes (the Firebase emulator CLI).
- PostgreSQL **17.12** in a local process on `127.0.0.1:55432`, with `pg` pool. It is **not** the requested Cloud SQL PostgreSQL 15 `db-f1-micro`; the cloud instances have not been provisioned because the AWFL consumer cannot access the Terraform state bucket and lacks database administration permissions.
- Three backends ran on the **same development consumer**, but in separate benchmark phases. The emulators ran simultaneously with one another; PostgreSQL was measured after the emulators shut down. They do not have equivalent CPU or durability settings.
- Per database and load level: **15 warm-up cycles + 75 measured cycles** of a complete `create → get → fenced claim → progress → fenced complete → get completed → raw put → raw get` execution sequence, then synthetic-record cleanup. ~1-KiB payloads and results, persistent connections, no shared execution keys between sampled cycles. 1 and 16 parallel workers. All **450 measured cycles across the three databases and two load levels succeeded**; no error durations are included in latency quantiles.
- Node.js 20.19.2. Runtime scheduling and emulator JVM garbage collection on a shared GKE consumer introduce high variance, especially at concurrency 16. The short sample size makes p99 particularly noisy.

## Serial samples (milliseconds, n = 75 per backend)

| Operation | Firestore emulator p50 | RTDB emulator p50 | Local PostgreSQL p50 |
|---|---:|---:|---:|
| Read | 5.42 | 3.84 | **0.48** |
| Raw write | 4.79 | 5.50 | **1.14** |
| Claim | 14.44 | 11.80 | **2.18** |
| Progress | 15.35 | 11.51 | **2.19** |
| **Complete (guarded)** | **13.67** | **13.30** | **2.32** |
| Complete p95 | 75.87 | 76.14 | 3.42 |
| Complete p99 | 87.24 | 87.59 | 14.34 |

## Sixteen concurrent independent executions (milliseconds, n = 75 per backend)

| Operation | Firestore emulator p50 | RTDB emulator p50 | Local PostgreSQL p50 |
|---|---:|---:|---:|
| Read | 98.98 | 109.95 | **4.06** |
| Raw write | 107.53 | 117.08 | **8.94** |
| Claim | 223.01 | 298.88 | **50.88** |
| Progress | 263.25 | 296.42 | **38.87** |
| **Complete (guarded)** | **300.71** | **286.96** | **41.90** |
| Complete p95 | 464.72 | 577.57 | 80.28 |
| Complete p99 | 465.52 | 595.99 | 88.86 |

## Interpretation and next work

1. The current local PostgreSQL transaction implementation provides the lowest measured latency for this execution lifecycle. It still does a `SELECT ... FOR UPDATE` and read-modify-write; a specialized one-statement conditional `UPDATE ... RETURNING` might improve that further, subject to the exact state checks.
2. A fast Firebase *raw* write does not imply a fast atomic execution completion. RTDB CAS requires an ETag read followed by a conditional PUT, and Firestore's guarded method uses a transaction. These both incur more than one logical interaction with the database. The two emulator implementations have similar serial completion latency.
3. The huge 16-worker emulator latency is largely evidence of heavy contention/scheduling/garbage collection in this **local emulator setup**; it is not a reliable measurement of production database scalability. The Java emulators, PostgreSQL, and cloud-managed services are not provisioned equivalently.
4. Compare the managed deployments **from the same Jobs region** with at least 1,000 warmed operations each once Terraform authorization exists. Include both raw writes and fenced completion, serial and concurrent, and report p50/p95/p99 with retry counts. The existing production Firestore `nam5` trace measured roughly 75 ms for the application-level completion method; that is real cloud evidence but from a different test.
5. Until then, the local data favors further PostgreSQL testing over a speculative wholesale move to Realtime Database. Keep the production backend unchanged until storage routing is consistent across execution creation, reads, and workers.

## Reproduce

```
firebase emulators:exec --project demo-awfl --only firestore,database \
  --config scripts/benchmarks/firebase.emulators.json \
  './scripts/benchmarks/runFirebaseEmulatorPilot.sh'
BENCHMARK=1 BENCHMARK_RUNS=75 BENCHMARK_CONCURRENCY=1 \
  firebase emulators:exec --project demo-awfl --only firestore,database \
  --config scripts/benchmarks/firebase.emulators.json \
  './scripts/benchmarks/runFirebaseEmulatorPilot.sh'
```

PostgreSQL: start a local PostgreSQL 17 server (with synthetic test user) and set `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`; then run `node scripts/benchmarks/storagePilot.mjs --backend=postgres --runs=75 --warmup=15 --concurrency=1` and repeat with `--concurrency=16`. For the emulator benchmark, repeat with `BENCHMARK_CONCURRENCY=16`. See the pilot README for correctness tests and cloud provisioning.
