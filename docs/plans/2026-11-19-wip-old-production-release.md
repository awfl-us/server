# AWFL wip-old reconciliation — production release record

**Status: merged, deployed and smoke-tested on 2026-11-19.**

## Scope and revisions

| Repository | `main` release commit |
| --- | --- |
| `awfl-us/workflow-utils` | `911722e` |
| `awfl-us/workflows` | `0214823` |
| `awfl-us/server` | `84998ae` |

The Rust compiler changes were already integrated into `compiler-rust/main`
at this checkpoint; there was no separate compiler release in this rollout.
The three completed reconciliation remote branches were deleted after
verifying they were ancestors of `main`.

## Production rollout evidence

- GitHub Actions `awfl-us/server` **Deploy to Cloud Run on Merge** run
  [44639870788](https://github.com/awfl-us/server/actions/runs/44639870788)
  completed successfully on commit `84998ae`, including the API and Jobs
  services, native GKE worker image, routing to latest stable revisions, and
  OAuth/anonymous-access checks.
- Final observed Cloud Run revisions: `api-00240-6ws` and `jobs-00236-xs4`;
  API `/health` returned HTTP 200. Jobs is intentionally private and rejects
  unauthenticated health requests.
- Production API and Jobs environment:
  `AWFL_DOCUMENT_STORAGE_BACKEND=postgres`,
  `AWFL_NATIVE_MEMORY_EXECUTION_ENABLED=1`,
  `AWFL_NATIVE_DOCUMENT_STORE_ENABLED=1`.
- The existing Terraform remote state at
  `gs://tfstate-awfl-web/infra/native-execution/default.tfstate` was used to
  change the native GKE deployment flag from `0` to `1`.
  Apply: **0 added, 1 changed, 0 destroyed**. The image itself is deployed
  through server CI, not Terraform.
- The complete 26/26 native Rust dependency closure for
  `codebase-ProjectManager` was published and activated in
  `gs://awfl-us-native-workflows/native-workflows/`. The active Project
  Manager artifact SHA-256 matched the built binary:
  `959a7f60662e5fa37bc76062849e610a4d7ff8e21de3a43e72857d5fac8c30db`.
  `helpers-ToolDispatcher` also matched its built binary:
  `3d10a42356c887935d0a7df8619eb210bca3bcef308a20ecbcfa92787fe2cfd5`.
- A real production Project Manager execution
  `native_ac889a2e593c45e2b963ed01c310f872` (session
  `9c01e190-10d4-4bcf-86ba-d49159c929c1`) completed with the exact
  response `AWFL_MEMORY_PG_SMOKE_OK`, with reported LLM usage of $0.00866125.
  GCP logging for this execution explicitly recorded
  `executionMode=memory`, `storageBackend=postgres`.

## Verified test gates

- 26/26 native closure binaries built and published.
- Compiled native PostgreSQL memory-mode session contention, explicit 409,
  delayed tool callback sequencing and manual retry all passed locally.
- Strict Jobs tool-schema validation emitted HTTP 422 and native EventHandler
  saved a terminal failure without dispatching invalid tool arguments.
- PostgreSQL storage CI succeeded on `3d54e76` after permitting its isolated
  loopback `/benchmark_ci` database. Production PostgreSQL names are rejected
  by these tests.
- Native Rust Try/Raise CI succeeded on final server commit `84998ae` after
  test expectations were updated for richer `native.parallel` error context.

## Operating decisions and follow-up

**Active execution mode is PostgreSQL-backed memory mode for latency.**
The legacy durable per-effect journal and its migration are **on the back
burner**; do not reinterpret old unresolved durability milestones as current
release blockers.

409 busy requests do **not** automatically queue and are deliberately not
persisted as unanswered turns. The submitting caller must retry explicitly.
Long-lived lock renewal and exactly-once behavior past expired leases are
not established by this release. The production smoke validated one real
Project Manager completion, not concurrent real-browser submissions or a
real-provider malformed-tool 422. These are future operational hardening
checks rather than claims of completed end-to-end coverage.

Historical design/test plans are retained as dated records:
`workflows/docs/plans/2026-11-wip-old-integration.md` and
`server/docs/plans/2026-11-19-native-callback-postgres-gate.md`.
