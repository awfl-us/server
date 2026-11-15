# AWFL execution-state storage pilot

**Decision:** [PostgreSQL on Cloud SQL `db-f1-micro` is the selected AWFL document-store backend](../../docs/postgres-storage-migration-plan.md). The [real three-way managed benchmark](../../docs/storage-pilot-managed-three-backend-benchmark-2026-11-14.md) measured 1,800 successful execution cycles and supports this choice. The pilot below is **not** the complete production Storage implementation or an application cutover. Keep Firestore/RTDB adapters here for comparison and compatibility; develop PostgreSQL as the full provider implementation.

This is the first, **single-record** slice of the SDK-independent storage
interface proposed by `docs/platform-agnostic-storage-implementation-plan.md`.
It is purposely not the complete Storage contract: it does not implement
cross-document transactions, global queries, or subscriptions. No adapter is
eligible for production-wide substitution until those operations pass the full
conformance suite. The existing Firestore-backed production execution store
is untouched, except that `createNativeJobsRouter` accepts an optional
`memoryStore` dependency for isolated integration tests/canaries.

The shared atomic record interface is `get`, `create` (create only), `put`,
`mutate` (atomic compare-and-update), and `delete`. A provider adapter implements
only this narrow contract. `NativeMemoryExecutionPilotStore` applies these
primitives to AWFL's `create`, `get`, `claim`, `updateMemoryProgress`,
`complete`, `fail`, and `cancel` memory-root operations. Status/owner/epoch/
lease fencing happens inside each backend's atomic mutation. The RTDB adapter
uses ETag-based CAS rather than nontransactional `get` + `set`.

## Run verification

```
node --test test/storage/*.test.mjs
cd infra/storage-benchmark && terraform init && terraform plan && terraform apply
```

The Terraform stack uses existing GCS state at
`gs://tfstate-awfl-web/infra/storage-benchmark/default.tfstate`.
It creates a **separate** RTDB and a Cloud SQL PostgreSQL 15 `db-f1-micro`
instance with IAM-only SQL user, and locks down RTDB client access. It does
not change the existing `nam5` Firestore database.

Use a GKE instance with access to all three backends and a Cloud SQL Auth
Proxy v2 `--auto-iam-authn` endpoint on localhost. Then run each backend:

```
node scripts/benchmarks/storagePilot.mjs --backend=firestore --runs=1000 --concurrency=1
RTDB_DATABASE_URL=... GOOGLE_ACCESS_TOKEN_FILE=... node scripts/benchmarks/storagePilot.mjs --backend=rtdb --runs=1000 --concurrency=1
PGHOST=127.0.0.1 PGPORT=5432 PGUSER=... PGDATABASE=awfl_bench node scripts/benchmarks/storagePilot.mjs --backend=postgres --runs=1000 --concurrency=1
```

Repeat with `--concurrency=16`. Token values are read from secret files, not
printed. Benchmarks warm connections, use only synthetic 1-KB records, report
per-operation p50/p90/p95/p99, verify create/claim/progress/complete, and
clean up benchmark keys. Timings include provider SDK or HTTP client overhead
and use the same state transitions for all backends. Compare durability
semantics separately (RTDB's rules and replication are not Firestore-equivalent).

**Historical auth troubleshooting (resolved):** An initial GKE Firestore SDK attempt using the consumer's workload identity returned `PERMISSION_DENIED`. The subsequent **successful managed-service** benchmark explicitly injected the Google user OAuth token into the Firestore SDK; no broad GKE consumer Firestore grant was needed. Failed attempts are excluded from latency samples.

**Managed benchmark completed:** The dedicated RTDB and `db-f1-micro` Cloud SQL
PostgreSQL instances are provisioned through the Terraform stack and its
shared GCS backend. The injected **user OAuth token** has the project Owner
rights needed for Terraform; do not confuse it with the `gcloud` configured
account label. The real 300-cycle sequential and 300-cycle 16-worker results
per backend are documented in
`docs/storage-pilot-managed-three-backend-benchmark-2026-11-14.md` along with
all six raw JSON result files. All 1,800 measured lifecycles succeeded. See
that report for significant high-concurrency PostgreSQL tail latency.

### Local Firebase emulator verification (no GCP credentials)

This verifies **real local** Firebase Admin SDK/Firestore transactions and
Realtime Database REST ETag conditional writes against emulators. It does not
approximate cloud network latency or Firestore multi-region commit time.
Install a compatible JDK (21+) and `firebase-tools`, then run from repo root:

```
firebase emulators:exec --only firestore,database --project demo-awfl \
  --config scripts/benchmarks/firebase.emulators.json \
  './scripts/benchmarks/runFirebaseEmulatorPilot.sh'
```

To also measure local emulator timings, prefix the command with `BENCHMARK=1`
(and optionally `BENCHMARK_RUNS=200 BENCHMARK_CONCURRENCY=16`). The demo
rules in `firebase.emulator.rules.json` are intentionally permissive and must
**never** be deployed to production. The RTDB adapter permits unauthenticated
plain HTTP only in explicit loopback-emulator mode; its production path still
requires HTTPS and an OAuth token provider. The conformance test covers 16
competing claims, create-only semantics, owner fencing, progress and completion.

**Verified locally on Nov 14 ET / Nov 15 UTC:** the Firebase emulators (Cloud
Firestore emulator v1.22.0, Realtime Database emulator v4.11.2) passed all
four live-emulator test assertions with the provider adapters; zero failures.

### Managed benchmark authentication

To run **against real services** from the AWFL GKE consumer, set
`GOOGLE_ACCESS_TOKEN_FILE` to the existing injected user OAuth token-file path
(`CLOUDSDK_AUTH_ACCESS_TOKEN_FILE`). The Firestore benchmark then uses the
normal Node Firestore client with a `google-gax`-supported `GoogleAuth` object
whose OAuth2 client holds the injected user token. This does not grant the GKE
service account additional Firestore permissions. RTDB uses the same token
through HTTPS REST. Do not log, print, or commit OAuth tokens.

For Cloud SQL, start the Cloud SQL Auth Proxy as a **persistent process**, e.g.:

```
cloud-sql-proxy --auto-iam-authn --port=5433 \
  awfl-us:us-central1:awfl-native-storage-bench
```

The proxy uses the attached GKE `awfl-consumer` workload identity and connects
to the *real* Cloud SQL instance; `PGHOST=127.0.0.1` is only the proxy's local
listener. Configure `PGPORT=5433`, `PGUSER=awfl-consumer@awfl-us.iam`,
`PGDATABASE=awfl_bench`, and `CLOUD_SQL_PROXY_INSTANCE` to make the benchmark
output mark it as managed. Run the `--backend=postgres` benchmark with a warm
connection pool. For all three backends repeat with `--concurrency=16`.

**Do not treat Firebase emulator measurements as managed service results.**
