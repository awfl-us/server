# Server `wip-old` reconciliation (2026-11-19)

Source `wip-old` bbbd5bf; target `main` 59c3ede (275 commits beyond branch base). The old branch is primarily **obsolete configuration**. Do not merge it or roll back the current native Rust / Postgres / GKE implementation.

## Decisions

| Old change | Decision | Current-state reason |
|---|---|---|
| `infra/gke.tf` Kubernetes provider, namespace, consumer/producer KSA and RBAC | **Reject wholesale** | Current main has native execution infrastructure in `infra/native-execution/gke-native-jobs.tf`, workload identity and `infra/gke-guardrails/`. Terraform state/provider ownership must not be duplicated by the old branch. |
| `k8s/rbac/awfl-job-launcher.yaml` with `__GSA_EMAIL__` placeholder | **Reject** | Don't introduce unrendered/duplicate RBAC to running GKE cluster. Review current namespace/worker permissions only if a reproducible permission failure exists. |
| `infra/wif_github.tf` and `github_variables.tf` rearrangements | **Reject** | High-risk unrelated IAM/state churn. |
| `jobs/llm.js` historical model list, prices, max tokens, curated allowlist | **Do not copy** | Main uses `jobs/llm/modelConfig.js` for model context/history budget and different pricing/usage paths. Historical values (e.g., GPT-6 variants) are not trustworthy current provider metadata. |
| `jobs/providers/openai.js` automatic `reasoning_effort: none` | **Reject blanket behavior** | Needs real per-model API capability checks; must not silently override current model/reasoning configuration. |
| `/workflows/llm/models` metadata | **Optional isolated improvement** | Current endpoint already returns `providers`, `inference`, `known_models`, `max_tokens`, and nested provider pricing. Only change if the web model-selector contract needs a normalized stable API. |

## Interface/tests if the web model selector is adopted

1. Define a stable model-catalog response with provider, valid model ID, limits, model availability, and **per-million token** prompt/cached/output prices (clearly specified units). Query current pricing source; do not use stale hardcoded wip pricing.
2. Test that web list contains only models that the real server can run, and old saved selections fail gracefully. Validate backend project/user authentication on the endpoint.
3. Contract-test `/models` with web's parsing. Current nested `pricing: {openai: {...}}` is **not** equivalent to flat `pricing[model]` expected by the old web implementation.
4. Run existing modelConfig tests and confirm that **17K Terra context budget is a deliberately deployed experiment**; this plan must not inadvertently restore 100K or change prefix/caching behavior.
5. Verify no changes to Postgres provider, native Rust invocation, effect journal/idempotency, GKE worker deployment, or production IAM without separate review.

**Exit:** zero server changes unless the optional catalog API contract is explicitly justified by the web slice. Leave current GKE deployment alone.
