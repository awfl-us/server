# AWFL PostgreSQL production cutover — operational runbook

**Current state (November 16, 2026 ET):** The existing Cloud SQL instance
awfl-native-storage-bench runs PostgreSQL 15 and contains the logical
databases awfl_prod and awfl_bench. Production API, Jobs and native GKE still
use Firestore; Firebase Auth and the explicitly separate MCP OAuth/workspace
control plane remain in Firestore after cutover.

## Applied infrastructure

- Terraform root: infra/storage-benchmark, remote GCS Terraform state
  tfstate-awfl-web/infra/storage-benchmark.
- A safe plan was applied: 4 resources created, 1 SQL instance updated in
  place, zero resources deleted.
- SQL IAM user and roles for the actual API/Jobs native GKE identity
  323709301334-compute@developer.gserviceaccount.com are provisioned.
- Backups, PITR, disk auto-growth and instance deletion protection enabled.
- Replanning must preserve the existing human SQL IAM user: set
  TF_VAR_benchmark_user_email to its current Cloud SQL IAM username.
- API/Jobs provider flags are in .github/actions-variables.json and the
  Cloud Run deployment workflow. Native GKE's flags are in
  infra/native-execution/gke-native-jobs.tf and default to Firestore.
- The Cloud SQL Node connector provides automatic IAM authentication and
  bounded pools, with no separate always-on proxy service.

## Inventory and repeatable finite migration

Observed source: 30 collection groups and 266,250 actual documents.
Two user parents and other virtual ancestors have no document body.
Largest groups include items, relayEvents, workflowExecsBySession,
workflowExecLinks, callbacks, messages and workflowExecStatus.
The inventory observed only JSON-compatible Firestore value types.

The primary tool is scripts/migrations/firestore_group_migration.py. It
discovers group names from real/virtual parents, reads with paginated
collection-group queries and ordered cursors, upserts in SQL batches, and
compares stable JSON content digests per group. It does not log secrets or
document values. The older firestore_to_postgres.py is a slow fallback.

With GCP token-file credentials, local Cloud SQL connector and psycopg
installed, set AWFL_MIGRATION_PG_DSN to the authenticated localhost SQL
connection and run:

    python3 scripts/migrations/firestore_group_migration.py discover --threads 24
    python3 scripts/migrations/firestore_group_migration.py inventory --page-size 800
    python3 scripts/migrations/firestore_group_migration.py copy --page-size 800 --ack-copy
    python3 scripts/migrations/firestore_group_migration.py verify --page-size 800

A real Cloud SQL copy-and-verify of five immutable benchmark records passed
with zero mismatches. Mutable project records differed between first copy
and verify because the source was still being written. This is expected
for the initial bulk staging pass, not acceptable for final cutover.

Excluded control-plane groups include root apiKeys, MCP owner/workspace/
OAuth records, legacy nativeWorkflowExecutions, mcpCommandKeys and
ephemeral locks.*. Those remain on their existing Firestore plane.

## Final cutover gate

1. Pass CI and provider-neutral storage, GKE, callback and session
   integration tests against PostgreSQL under the real runtime IAM identity.
2. Stop new legacy native launches and allow/resolve existing durable
   Firestore native roots. Do not treat those records as native memory roots.
   Keep legacy native callbacks in Firestore until the native-document-store
   flag is separately enabled after draining.
3. Quiesce all remaining Firestore document-data-plane writers. Repeat
   the idempotent copy, run verify, require zero mismatches in every included
   group, and keep writers quiesced until the switch.
4. Enable PostgreSQL for API/Jobs via repo deployment config; update native
   GKE via Terraform variable native_jobs_document_backend. Keep
   native_jobs_document_store_enabled=false until legacy roots are drained.
5. Verify normal authenticated Project Manager, session histories, event
   subscriptions/reconnect, native children/callbacks/cancellation, runtime
   restart and new SQL mutations. Verify no new document data-plane writes
   unexpectedly hit Firestore. Keep Firebase Auth/MCP operational.
6. Retain original Firestore as rollback/history; do not overwrite newer
   PostgreSQL writes with an old Firestore snapshot on rollback.
7. After cutover, profile all document-storage operations and remaining
   Jobs/model/HTTP latency end to end, particularly p95.

**Do not delete Firestore.** Firebase Auth, MCP OAuth/workspace request
control plane and legacy durable native histories intentionally remain.
This does not require a second always-on SQL instance.
