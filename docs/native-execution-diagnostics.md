# Native execution diagnostics

Use `scripts/native-trace-logs.sh native_<execution-id> [gcp-project] [lookback-days]` in an AWFL environment with `gcloud` access. The script uses the injected GCP access token when available. It searches logs by the *root* execution ID and displays timestamp, service, event, workflow, operation, effect ID, nested execution/parent ID, duration, and bounded error reason. Increase the lookback window for older runs.

New structured Cloud Logging events:

- `awfl_native_execution_selected`: API launcher decision, published workflow digest and capabilities, selected executor and storage backend.
- `awfl_native_execution_started`, `awfl_native_execution_completed`, `awfl_native_execution_failed`: Jobs execution mode and storage backend.
- `awfl_native_workflow_started`, `awfl_native_workflow_completed`: Every in-process workflow and its caller, with depth and duration.
- `awfl_native_effect_started`, `awfl_native_effect_completed`: Durable and in-process effects; correlate by `rootExecutionId`, `executionId`, `effectId`, `nodeId` and `operation`.
- `awfl_native_effect_failed`, `awfl_native_transition_failed`, `awfl_native_workflow_failed`: Redacted original exception and bounded stack trace, including the failing child execution.
- `awfl_native_effect_failed_recorded`, `awfl_native_effect_uncertain`: Whether an effect was durably recorded as failed or left pending for reconciliation.
- `awfl_native_parallel_lane_failed`: The failed fork lane's deterministic child execution ID and cause.

No workflow arguments, model prompts, callback URLs, credentials or response bodies are included in these *native execution* event logs. Diagnostic strings are bounded and common credential patterns redacted. The compiled `Try` now receives a bounded, redacted reason prefixed by operation and effect ID rather than the generic `native effect failed`; it does not change retry or reconciliation behavior. Inspect GCS OpenAI request captures separately when enabled; those are sensitive and subject to their own access and retention restrictions.

Historical durable runs store root/fork execution checkpoints and `effects` journals in Firestore. Native **memory** roots can still use Firestore when `AWFL_NATIVE_DOCUMENT_STORE_ENABLED=0`; when that flag is enabled consistently in API, Jobs and GKE and the selected document backend is `postgres`, memory execution state uses PostgreSQL. In-process nested workflow calls do not create their own durable per-effect journals, which is why correlation logs matter. Keep the two types of persistence separate when investigating.

## Mixed-mode detached recovery

When Firestore is the native execution store, the GKE scheduler dispatches each detached child by its persisted `executionMode` rather than its own global feature flag. Newly detached memory children are written with `executionMode=memory`; legacy durable children without the marker still use durable execution. A historical child with an untagged mode whose parent is memory-mode (or missing) is quarantined with `awfl_native_legacy_detached_mode_missing` instead of running through the wrong executor. Relaunch or carefully repair those historical records after verifying their lineage; this change does not rewrite old execution records automatically.
