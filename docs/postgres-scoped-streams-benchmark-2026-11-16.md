# PostgreSQL scoped-stream contention retest — November 16, 2026

**Environment:** AWFL server GKE lightweight consumer in us-central1 → Cloud SQL Auth Proxy (automatic IAM database login) → Cloud SQL PostgreSQL 15 `db-f1-micro` shared-core, database `awfl_bench`. Same instance, client, pool, workload and benchmark script in both trials. This is an isolated benchmark database; production still uses Firestore.

## Change under test

Before: every mutation of `awfl_documents` increments `awfl_storage_cursor(name='all')`, appends a durable change snapshot and sends a notification. The shared row lock persists until commit, so independent transactions block and `SERIALIZABLE` updates can exhaust 24 retries.

After applying `storage/postgres/migrations/001_scoped_event_streams.sql`: document writes issue a commit-time NOTIFY containing the path but **no event-log write/cursor lock**. Session/project event streams have separately allocated cursor rows, touched only when explicitly appending an event. The old change-log tables are retained and inactive.

## Method

`scripts/benchmarks/postgresDocumentContention.mjs`, 16 concurrent workers × 24 operations each for each phase (384 requested operations/phase). Separate phase measurements for:
- `put` on distinct existing documents
- `update` using current `SERIALIZABLE` read/modify/write and `patch.increment`, with each worker writing a distinct document
- `create` on distinct new documents

One warmup read/write for each worker. Persistent pool max 17 (database max connections previously measured at 25). Successful attempts only contribute to percentiles; unsuccessful operations are counted separately, never silently excluded from success counts. The benchmark then deletes its random-prefix documents. Both trials were run from the same worker within one minute. One measured trial per condition, so short-term load jitter remains possible.

## Managed Cloud SQL results (milliseconds)

| Phase | Global p50 | Scoped p50 | Global p95 | Scoped p95 | Global p99 | Scoped p99 | Errors before → after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Create | 20.66 | **11.93** | 121.32 | **16.13** | 224.76 | **84.10** | 0 → 0 |
| Put/replace | 14.48 | **11.61** | 63.17 | **22.52** | 125.01 | **110.12** | 0 → 0 |
| Serializable update | 94.08 | **16.09** | 749.47 | **93.37** | 1058.75 | **101.03** | 10 → **0** |

Successful serializable-update throughput increased from **65.54** to **616.61 operations/second** (~9.4×). Its p50 improved 5.8× and p95 8.0×. The 10 failed baseline updates returned SQLSTATE `40001` despite built-in retries; all 384 completed after removing global serialization.

Raw outputs:
- [Legacy global cursor](../benchmarks/postgres-scoped-streams-2026-11-16/cloud-sql-before.json)
- [Scoped event streams](../benchmarks/postgres-scoped-streams-2026-11-16/cloud-sql-after.json)

## Caveats

- These are **generic document adapter** measurements, not the original November 14 single-record pilot (which did not contain the global cursor). Do not attribute that pilot's high-concurrency p99 directly to the cursor.
- Tests use independent document keys. Multiple writers to the **same document** or many appends to **the same event stream** must still serialize to preserve correctness.
- The database remains a small shared-core instance, and high-percentile latency can still fluctuate due to CPU, WAL fsync, network/proxy and pool scheduling.
- New watch semantics are state convergence, **not** durable per-mutation replay. Callers requiring each event must migrate to session/project `appendEvent` + `subscribeEvents`. The SSE relay has **not yet been switched** to the new stream API.
- Do not duplicate every session message into one ordered project-wide event stream: that would reintroduce contention at the project level. Reserve project streams for genuinely project-level ordered events; project-wide session views can merge independent session streams without a globally contended per-write cursor.
- An isolated PostgreSQL 15 GitHub Actions job also runs old/new trigger benchmarks, but its latencies reflect hosted CI, not Cloud SQL.

## Verification

The managed Cloud SQL PostgreSQL integration suite, including document watcher convergence, cross-process changes, session replay/idempotency and independent session/project cursors, passed **7/7** after migration. The full CI storage suite and automated CI benchmark are tracked in server [PR #134](https://github.com/awfl-us/server/pull/134).

**No production backend configuration, data routing, or Terraform resource was changed.**
