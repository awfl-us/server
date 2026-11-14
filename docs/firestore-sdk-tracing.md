# Firestore Admin SDK profiling (production opt-in)

The existing Firebase Admin SDK/Firestore client is instrumented in place.
No persistence code, document schemas, or workflow definitions change. This
profiling is independent of the planned @awfl-us/storage abstraction.

## Deployment

- AWFL_FIRESTORE_TRACE_ENABLED=1 enables a Node OpenTelemetry tracer before
  importing Firebase Admin; it also sets FIRESTORE_ENABLE_TRACING=ON.
- AWFL_FIRESTORE_TRACE_SAMPLE_RATE=1 samples 100% of trace roots (0..1).
- API and Jobs Cloud Run receive these flags from .github/actions-variables.json,
  whose authoritative template is infra/github_variables.tf.
- infra/native-execution/gke-native-jobs.tf sets the same flags on the
  persistent native GKE Jobs worker. That Terraform root has existing remote
  state; apply it to update the pod environment (CI image rollout alone does
  not update pod environment variables).
- infra/observability/ is a separate Terraform root with GCS-backed state.
  It enables the Telemetry API and grants roles/telemetry.tracesWriter to
  the runtime service account used by API, Jobs, and the native GKE worker.
  Do not apply the unrelated legacy server/infra root without trusted state.

Traces are exported in-process using standard OpenTelemetry OTLP HTTP/protobuf
directly to https://telemetry.googleapis.com/v1/traces. google-auth-library
refreshes auth for each export batch. No collector or new service is required.
The SDK exporter adds some overhead. Benchmark with tracing enabled and disabled
to isolate it. Firestore tracing is a Google Preview feature and does not
instrument realtime onSnapshot listeners.

## Correlation and privacy

Lightweight middleware creates root spans in API and Jobs. It records only the
method and a fixed route family, never the raw URL, query, headers, bodies,
tokens or user IDs. On the native execution endpoint, the authenticated
execution ID and mode are added as awfl.execution_id / awfl.execution_mode.
Native HTTP effect calls propagate W3C traceparent context to downstream Jobs.

Firestore-generated spans may include resource identifiers and errors. Cloud
Trace is access controlled; review retention, IAM and any identifiers before
sharing traces publicly.

Cloud Trace Explorer: https://console.cloud.google.com/traces/explorer?project=awfl-us

## Analysis

1. Start a normal Project Manager session and record its execution ID and UTC
   timing window.
2. Search Cloud Trace for a root span carrying awfl.execution_id on the Jobs
   native execution request; use service.name to distinguish awfl-api, awfl-jobs
   and awfl-native-worker. The W3C trace can contain child Jobs calls.
3. Group Firestore client method/RPC spans by operation; calculate sum of
   inclusive durations separately from the union of wall-clock intervals
   because parallel calls overlap. Do not double-count application-level
   HTTP /firebase requests and the nested Firestore SDK spans.
4. Check logs for OTLP 401/403/429, verify telemetry API/IAM, and rerun if
   the trace root was unsampled. Realtime subscriptions are not captured
   by the SDK (measure listener lifetimes separately).
5. Repeat matched executions with tracing disabled to establish the actual
   instrumentation cost if necessary.

## Disable / rollback

Set AWFL_FIRESTORE_TRACE_ENABLED=0 in the repo-managed Cloud Run settings
and GKE Terraform and redeploy/apply. This stops tracing without changing
database behavior, production native execution mode, or data.
Keep AWFL_NATIVE_MEMORY_EXECUTION_ENABLED=1 unchanged.

Reference: Google Firestore client-side tracing documentation, Node.js Admin;
Google Cloud Telemetry API and OTLP migration guide.
