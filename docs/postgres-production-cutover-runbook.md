# AWFL PostgreSQL production cutover — operational runbook

**Current state (November 17, 2026 at 12:56 UTC):** The existing Cloud SQL instance
awfl-native-storage-bench hosts logical databases awfl_prod and awfl_bench.
Production API, Jobs and the GKE document provider now use PostgreSQL awfl_prod.
Firebase Auth, MCP OAuth/workspace control plane, and the legacy native execution
journal and callbacks intentionally remain in Firestore.

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
  infra/native-execution/gke-native-jobs.tf and default to PostgreSQL.
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
    python3 scripts/migrations/firestore_group_migration.py sync --page-size 800 --ack-copy
    python3 scripts/migrations/firestore_group_migration.py verify --page-size 800

A real Cloud SQL copy-and-verify of five immutable benchmark records passed
with zero mismatches. A second SQL sync checked the same five records and
reported changed=0, unchanged=5, extras=0 and zero verification mismatches.
The sync mode loads SQL path/digests and writes only changed/missing documents,
avoiding thousands of unnecessary SQL upserts during final reconciliation. Mutable project records differed between first copy
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

## Optional post-cutover fenced reconciliation

If a brief provider switch occurs while very old Firestore writes are
finishing, record the exact UTC cutover timestamp. The sync and verify modes
accept --cutover-at with an ISO 8601 timestamp, e.g.:

    python3 scripts/migrations/firestore_group_migration.py sync --ack-copy --cutover-at 2026-11-17T04:00:00Z
    python3 scripts/migrations/firestore_group_migration.py verify --cutover-at 2026-11-17T04:00:00Z

This fences source reconciliation against PG documents updated since the
cutover timestamp, **including at SQL statement execution time**, and excludes
PG-owned post-cutover documents from legacy-source verification. The preferred
path remains a quiescent final sync before switching; the fenced mode is
additional recovery protection, not permission to split one native root
between providers. Old Firestore writes are not deleted by this tool.

## Required SQL grants after migration and schema setup

The Cloud SQL runtime user can authenticate via IAM, but IAM alone does not
grant SQL table read/write access. On November 17, the first authenticated
Cloud Run canary failed with a SQL permission error on awfl_documents.
A scoped SQL grant was applied and all SELECT, INSERT, UPDATE, DELETE privileges
were verified on the three AWFL tables.

To apply and verify the idempotent grant at schema setup and after future
SQL table migrations, run as the existing awfl-consumer SQL migration owner:

    export AWFL_MIGRATION_PG_DSN='postgresql://<owner>@127.0.0.1:5452/awfl_prod'
    export AWFL_POSTGRES_IAM_USER='323709301334-compute@developer'
    python3 scripts/migrations/grant_postgres_runtime.py

The script checks expected database, owner and table ownership, and grants
only the existing AWFL data/stream tables plus default table privileges for
future tables created by the same migration owner. Keep Auth and the MCP
control-plane persistence in Firestore.

## Production cutover completed — 2026-11-17 12:56 UTC

The successful final differential sync examined **269,263 Firestore documents**
across 30 collection groups, updating 326 records and finding 268,937
unchanged and no extra SQL records. Live GKE native scheduler configuration
was switched to the PostgreSQL document backend, but native memory execution
stayed disabled (the legacy Firestore native journal and callbacks remain).

Verified release (GitHub Actions run 44087709682):

- API: **api-00214-qen**, 100% production traffic; PostgreSQL selected.
- Jobs: **jobs-00221-jad**, 100% production traffic; PostgreSQL selected.
- GKE: native-jobs deployment rolled out and ready with PostgreSQL selected
  for documents and AWFL_NATIVE_DOCUMENT_STORE_ENABLED=0.
- HTTPS: live /health returned 200; unauthenticated /mcp and /mcp/agents
  returned expected OAuth/authentication 401, not maintenance 503.
- AWFL live project-list tool successfully returned the real projects after
  the cutover. Production SQL IAM grants and read/write canary were verified
  prior to traffic promotion.

Last-known-working Firestore rollback revisions are API **api-00207-9bd**
and Jobs **jobs-00202-dh8**. The original Firestore data was not removed.
This rollout's GKE environment update was performed by the authenticated
GitHub deployer with its existing scoped Kubernetes permission; the Terraform
desired default in this commit is synchronized to PostgreSQL. A future
Terraform plan should be run with an identity that already has the remote
state bucket permissions; do not widen the general GitHub deployer's access
solely to operate state.
