# AWFL execution-state storage pilot

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

**Observed attempt:** The real GKE Firestore pilot emitted `PERMISSION_DENIED`
when creating synthetic records; those operations are invalid benchmark samples
and are excluded from success latency distributions. A dedicated benchmark
identity needs `roles/datastore.user` for the Firestore baseline. No live
successful comparison has been recorded yet.

**Current provisioning block:** The AWFL cloud consumer identity does not have
read access to the remote Terraform state bucket and neither it nor the GitHub
Cloud Run deployer has permissions to administer the requested databases. A
Terraform-capable infrastructure identity must provision the dedicated stack.
Do not work around this by creating resources outside Terraform or checking
in a local Terraform state file. Until provisioned, there are no legitimate
three-backend measured latency results.
