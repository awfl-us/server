# Storage pilot: local PostgreSQL baseline (November 14, 2026 ET)

This is **real PostgreSQL**, not the `db-f1-micro` Cloud SQL instance and not a comparison against live Firebase. It validates the adapter's native execution lifecycle and establishes a local lower-bound latency reference; it cannot measure the WAN/Google Cloud managed database network overhead.

## Test environment

- AWFL lightweight GKE development consumer; one standalone local PostgreSQL **17.12** process listening on `127.0.0.1:55432`, not a managed database. Shared development pod CPU and disk, no production service traffic.
- Node 20.19.2 client with `pg` pool using persistent connections (project CI uses Node 22); `postgres.js` JSONB adapter from PR #121.
- Synthetic 1 KiB input and 1 KiB result, 400 complete execution cycles per condition, 25 warmup cycles excluded. Every cycle does `create`, `get`, `claim`, `progress`, `complete`, `get completed`, `raw put`, and `raw get`, then removes synthetic data. All **800/800 cycles succeeded**.
- 9/9 shared correctness tests passed against actual local PostgreSQL, including the 16-way racing-claim and lease expiration test from PR #123. The other two Firebase adapters have passing mocked unit tests, **not** live emulator/production measurements.

## Success latency in milliseconds

| Operation | Serial p50 | Serial p95 | Serial p99 | 16 concurrent p50 | 16 concurrent p95 | 16 concurrent p99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `state.create` | 1.260 | 1.989 | 6.929 | 5.330 | 68.200 | 196.915 |
| `state.get` | 0.449 | 0.804 | 0.952 | 3.287 | 61.598 | 70.188 |
| `state.claim` | 1.990 | 2.803 | 4.478 | 15.147 | 85.308 | 323.767 |
| `state.progress` | 1.839 | 2.759 | 5.710 | 13.603 | 82.828 | 323.529 |
| `state.complete` | **1.931** | **2.956** | 3.244 | **14.879** | **83.834** | 324.045 |
| `state.getCompleted` | 0.434 | 0.829 | 0.933 | 2.804 | 57.712 | 71.490 |
| `raw.put` | 1.099 | 1.664 | 2.033 | 4.869 | 63.031 | 104.486 |
| `raw.get` | 0.383 | 0.824 | 2.109 | 2.912 | 60.365 | 284.933 |

Cycle duration including cleanup: 6,318 ms sequential; 6,003 ms at concurrency 16. These results are from the existing generic `SELECT FOR UPDATE` + JSONB update implementation (four SQL statements, plus connection pool scheduling) rather than an optimized single conditional `UPDATE ... WHERE`.

## Interpretation and next tests

Sequential local PostgreSQL meets the desired sub-5-ms execution lifecycle median for the current data size. High-concurrency p95 was much worse under the shared test environment; avoid promising a production tail latency based on this local server. Potential causes include shared pod CPU/disk contention, fsync, pool wait, PostgreSQL scheduling, and the four-RTT generic transaction. Identify the bottleneck using warm connections, pool-wait measurements, `pg_stat_activity`, and a one-statement `UPDATE ... RETURNING` variant if optimizing the adapter. Don't disable durable commits just to win the benchmark.

The existing production Firestore trace recorded ~75 ms for one application-level `complete` with ~27 ms document read and ~45 ms commit, but this is **a different workload/environment**. Firebase RTDB has not been provisioned; there are no valid remote RTDB results. A failed attempt to write synthetic Firestore documents in the AWFL consumer returned `PERMISSION_DENIED`; error duration is not a write-latency sample (corrected in PR #122).

For a true same-environment comparison, provision Firestore/RTDB + Cloud SQL via `infra/storage-benchmark` with an infrastructure identity authorized for the Terraform GCS state bucket. No cost-bearing benchmark resources or production database migration were performed during this local test.
