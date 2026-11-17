# PostgreSQL production cutover — live audit checkpoint (2026-11-16 ET)

This is an implementation checkpoint for [PR #139](https://github.com/awfl-us/server/pull/139) and the [cutover handoff](postgres-production-cutover-latency-handoff-2026-11-16.md), **not a production cutover announcement**.

## Verified against the live `awfl-us` project

- API revision `api-00194-9q4` and Jobs revision `jobs-00189-7vq` are deployed; neither Cloud Run service currently sets `AWFL_DOCUMENT_STORAGE_BACKEND`, `AWFL_NATIVE_DOCUMENT_STORE_ENABLED`, or PostgreSQL connection settings. Firestore remains the configured document backend.
- The only Cloud SQL instance is `awfl-native-storage-bench`, PostgreSQL 15 in `us-central1`, `db-f1-micro`. It is runnable, has 10 GiB disk, **backups disabled** and **point-in-time recovery disabled**. Its existing Terraform owner is `infra/storage-benchmark` with remote GCS state `tfstate-awfl-web/infra/storage-benchmark`. Do not provision or import duplicate ownership.
- API and Jobs run as `323709301334-compute@developer.gserviceaccount.com`. The benchmark instance has an IAM database user for `awfl-consumer@awfl-us.iam`, but the Cloud Run runtime service account is not yet a corresponding IAM database user. GKE native-Jobs scheduler Workload Identity also uses the Compute runtime service account (see `infra/native-execution/gke-native-jobs.tf`).
- `jobs/native.js:startNativeDetachedRecovery` **throws when `AWFL_NATIVE_DOCUMENT_STORE_ENABLED=1`** for a persistent native scheduler. Changing API/Jobs environment variables alone would break recovery. Its durable native execution and detached scheduler are still Firestore-specific. Production native-memory execution cannot be called worker-recoverable until this is resolved.
- `api.server.js` creates the MCP `ExecutionService` and OAuth router with `getFirestore()`. Inspect those paths separately: Firebase **Auth** must remain, but document persistence for sessions/credentials should not silently diverge from PostgreSQL.
- `workflows/native/backend.js` rejects incompatible releases when configured with the memory document store. Preserve this fail-closed contract, check each deployed native artifact/release, and avoid mixing backend selection within one root and its children.
- Cloud Run deployment is driven by `.github/workflows/deploy-cloud-run.yml` on merge to `main`, and it replaces deployed environment variables from its common-env configuration. Configure provider, connector/IAM, and bounded pools in that deployment path before enabling PostgreSQL; a one-off `gcloud run services update` will not be a durable configuration change.

## Branch reconciliation

The feature branch was four `main` commits behind as of the audit. The merge had two conflicts: `docs/postgres-scoped-streams-benchmark-2026-11-16.md` (documentation) and `workflows/googleCloud/consumerRefresh.js` (new pod-restart Firebase bootstrap versus provider-neutral project read). The provider-compatible Firebase bootstrap change is saved in feature commit [`b8ac5f1`](https://github.com/awfl-us/server/commit/b8ac5f1b0287d438edacbb02463b5e048e921317). **The full main merge has not been committed.**

The GKE cloud consumer terminated during a multi-test command. One real Python HTTPS Firebase bootstrap integration subtest reported PASS before the consumer was lost; the whole command was **not** verified. The consumer then reported `BackoffLimitExceeded`; do not claim the integration suite passed or that any production migration occurred.

## Cutover gates and practical path

1. Restore a healthy execution environment; reconcile `main` on PR #139 and run Firebase-bootstrap, Jobs storage, PostgreSQL integration, SSE, callback, and native execution tests separately. Confirm the packaging change in merged `main` includes `storage/`.
2. Inventory all Firestore collections, counts, nested subcollections, value types, and active executions without logging credential values. Export into an encrypted, temporary migration artifact; import only retained data into a distinct `awfl_prod` database and compare counts/checksums and representative session event replay.
3. Favor **reusing the already Terraform-owned Cloud SQL instance** initially instead of adding a second database *service*, provided connection counts and reliability prove adequate. Make production data a separate database, enable backups/PITR, database deletion protection and disk auto-growth in its existing Terraform root, configure IAM for the actual API/Jobs/GKE identities, and test restore. The shared-core tier (previously observed max_connections=25) requires strict small pools and Cloud Run instance limits; scale the tier if real load or p95 indicates a need. No promotion before Terraform plan and validation.
4. Provide a working Cloud SQL connection path with **automatic IAM database authentication** for each Node service and persistent worker. A connector/proxy alone is not proof that database IAM login succeeds. Run versioned SQL migrations explicitly prior to live traffic.
5. Migrate or explicitly isolate the MCP control plane, and implement native memory-mode detached recovery before enabling it on the persistent GKE scheduler. If old durable Firestore roots exist, drain/fence those roots separately rather than moving their state mid-flight.
6. Switch API, Jobs and GKE consistently via Terraform/deployment configuration; verify ordinary authenticated Project Manager, session history, subscriptions/reconnect, tool callbacks, nested children, cancellation and restart, with confirmed PostgreSQL reads/writes and rollback.
7. Only then instrument every provider-neutral Storage call and run the production end-to-end latency analysis described in the handoff. Local median native-store ~9× improvement **is not** a full Jobs database timing comparison.

No production infrastructure or backend setting was changed by this audit.

## Finite migration implementation (new checkpoint)

- A one-time Firestore REST traversal script is in
  scripts/migrations/firestore_to_postgres.py, with inventory, explicit schema
  initialization on an empty PostgreSQL database, copy and verify modes.
  It enumerates missing parent documents (two virtual users observed), all
  nested project/session collections, and explicitly excludes the separate MCP
  OAuth/workspace control plane and legacy durable native journals.
- Migration comparisons use stable document paths and JSON digests. The codec
  converts timestamps to ISO strings, rejects unsafe integers, nonfinite floats,
  and unreviewed bytes/reference/GeoPoint types rather than silently losing
  information. Values/credentials are never included in inventory logs.
- The script is not an ongoing dual-writer. For the final import, quiesce
  Firestore writes, preserve old database/archive access, initialize SQL schema
  explicitly, copy, verify, then switch API/Jobs/persistent GKE as a unit.
  Avoid rerunning the insert-only copy after application traffic is on PG.
- Database infrastructure has been applied from the existing
  infra/storage-benchmark Terraform GCS state: four additions, one in-place
  update, zero deletions. This created awfl_prod and runtime IAM access,
  enabled backups/PITR/disk auto-growth and deletion protection. It did
  **not** change API/Jobs backend selection; those remain Firestore.

**Terraform state safety:** Always supply the existing Cloud SQL human IAM
user when planning/applying the storage-benchmark Terraform root, or its
existing SQL user and two IAM grants would be scheduled for deletion.
The variable is required rather than defaulting to empty.
Populate TF_VAR_benchmark_user_email from:
gcloud sql users list --instance awfl-native-storage-bench --project=awfl-us
--filter=type=CLOUD_IAM_USER --format=value(name).
Confirm the plan has zero deletions before applying. A verified safe plan
was applied with 4 additions, 1 in-place Cloud SQL change, and 0 destroys.

## Later migration checkpoint (supersedes the historical pre-change audit)

The original sections above describe a pre-change snapshot. In subsequent
work, main was merged to the feature branch in commit 3e7a226, all four
GitHub test workflows passed, and safe SQL Terraform was applied:
four additions, one in-place SQL update, zero deletions.
The logical production database awfl_prod is provisioned on the existing
SQL instance with IAM, backups, PITR, disk auto-growth and deletion protection.
Production services are **still on Firestore**, not yet switched.

An optimized collection-group importer, discoverer and verifier is now in
scripts/migrations/firestore_group_migration.py and supersedes the slow
per-document REST inventory. Full read-only inventory: 30 collection groups,
266,250 documents, eight JSON-compatible value kinds. Five immutable
benchmark documents passed actual SQL copy/verify with zero mismatches.
Bulk staging copy is underway. Final source-drained sync/verify is mandatory
before traffic cutover. See postgres-production-cutover-runbook.md.

Existing native callback records stay in their original Firestore journal
until the native document-store flag is enabled after draining legacy roots;
the PG document migration must not split one root's state and callbacks.
Firestore will remain available for Firebase Auth, MCP control-plane
records and legacy execution history.
