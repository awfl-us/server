# PostgreSQL transient live bus — 2026-11-26

Source: `workflows/events/postgresLiveBus.js`; harness: `scripts/benchmarks/postgresLiveBus.mjs`. The bus uses encrypted notifications without event/document writes. The optional document probe intentionally writes/reads one isolated synthetic Storage document, then removes it.

## Environment and reproduction

Cloud SQL `awfl-native-storage-bench`, PostgreSQL 15.19, `db-f1-micro`, 10 GB, max_connections 25; DB `awfl_bench` (not `awfl_prod`). Both DBs share the instance. Existing IAM proxy, GKE lightweight consumer, two publisher processes and two listeners, one connection per process plus observer. Each offered rate lasts about two seconds, with 128-byte text plus envelope and encryption. Both listeners subscribe to both independent sessions. Time measured from enqueue to notification callback on the same pod; includes publisher queue and database/network latency. Numbers in tables use worst of the two listeners for each percentile.

```sh
# Existing authorized IAM proxy on port 5543; keep it running for tests.
export PGHOST=127.0.0.1 PGPORT=5543 PGUSER=awfl-consumer@awfl-us.iam PGDATABASE=awfl_bench
node --test workflows/events/postgresLiveBus.test.js
AWFL_LIVE_PG_TEST=1 node --test test/storage/postgresLiveBus.integration.test.mjs
node scripts/benchmarks/postgresLiveBus.mjs
LIVE_BENCH_DOCUMENT_PROBE=1 node scripts/benchmarks/postgresLiveBus.mjs
```

## Run 1: SELECT 1 concurrent probe

| Offered/s | Accepted | Per-listener deliveries | p50 ms | p95 ms | p99 ms | Max publisher backlog | Probe p95 ms |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 50 | 100 | 100 | 3.35 | 4.45 | 9.87 | 1 | 2.99 |
| 100 | 200 | 200 | 2.93 | 3.69 | 4.97 | 1 | 2.74 |
| 500 | 1000 | 1000 | 2.31 | 3.42 | 7.49 | 3 | 3.10 |
| 1000 | 2000 | 2000 | 168.16 | 207.91 | 212.91 | 110 | 13.67 |

Baseline probe p95 3.29 ms. Highest sampled pg_notification_queue_usage ~0.00000191 (fraction).

## Run 2: PostgresStorage document put+get concurrent probe

| Offered/s | Accepted | Per-listener deliveries | p50 ms | p95 ms | p99 ms | Max publisher backlog | Probe p95 ms |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 50 | 100 | 100 | 3.11 | 4.09 | 11.39 | 1 | 6.74 |
| 100 | 200 | 200 | 2.87 | 3.71 | 5.36 | 1 | 6.53 |
| 500 | 1000 | 1000 | 2.24 | 4.22 | 7.62 | 3 | 8.57 |
| 1000 | 2000 | 2000 | 169.61 | 230.96 | 248.81 | 127 | 15.58 |

Baseline probe p95 8.09 ms; highest sampled notification queue fraction ~0.00000286. At every rate both listeners saw all accepted events, zero rejected/lost/duplicate/out-of-order events. At 1000/s publisher drain took 2153 ms instead of the nominal 2000 ms; no claim of sustained throughput at that rate.

## Decision and limitations

100/s initial target (<50 ms p95, no loss and no material probe regression) passed. Short 500/s trial also performed well; 1000/s exceeded low-latency capacity and accumulated a sender-side backlog. Do not introduce timed batching. Keep the bounded queue; report failure/gaps and use snapshot reconciliation in the next phases. Five benchmark connections are significant on a 25-connection instance; production deployment must allocate a connection budget across actual replica caps and existing document pools. No new infrastructure. Tests are not a sustained load or CPU benchmark; the document probe is not a full workflow. No production DB writes or production workload comparison; physical instance is shared, so interference cannot be excluded. Real end-to-end streaming, snapshots and production authorization remain pending.
