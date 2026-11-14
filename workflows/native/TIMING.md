# Opt-in timing for a native Jobs execution

**New memory-first mode:** see [MEMORY.md](MEMORY.md). This path avoids the
per-effect Firestore journal altogether for opted-in non-parallel workflows;
it retains only an initial claim, optional asynchronous progress, and one
awaited terminal result write. Historical call counts below describe the
legacy durable execution mode.

## Reusing the active worker's durable state (November 12, 2026)

The worker now holds the **state returned by each successful Firestore
transaction in memory** until the next native transition. The original
Firestore document remains authoritative for recovery. This does *not*
introduce a second state service, change the Rust protocol or buffer
irreversible effects asynchronously.

For a one-effect `helpers-ToolDefs` run, the real Rust regression test now
observes **2 reads, 1 claim, 0 renewals, 1 durable effect preparation, 1
effect journal write, and 1 completion**. Previously the worker read four
times, claimed twice and renewed once. Firestore remains the checkpoint and
effect-journal source of truth, with the same transaction-level fencing.
The dispatcher still performs a **fresh read immediately before an external
effect** to reject a cancellation or lease takeover. A later Cloud Tasks
delivery with no local state always starts with a fresh Firestore read/claim.
Long-lived executions still renew leases when near expiry. Multi-branch
parent heartbeat behavior is unchanged.

The native process is still invoked per continuation: measurements showed its
execution took ~19 ms and the larger delays were Firestore/GCS/network.
Avoid adding a long-lived Rust-process protocol until actual evidence calls
for it. This simplification should be measured on the isolated Jobs canary,
not assumed to produce a speedup before cloud benchmarking.

The production Jobs service enables `AWFL_NATIVE_PROFILE_ENABLED=1` through
`server/infra/github_variables.tf`, the generated
`.github/actions-variables.json`, and the Jobs-only Cloud Run deployment step.
API remains unprofiled. A successful or failed native Jobs request
then writes one structured `awfl_native_job_timing` Cloud Logging event,
containing its execution ID, outcome, total request duration and aggregated
phase timings. The response body and execution behavior are unchanged.

Phases include `gcs.materialize`, `firestore.get`, `firestore.claim`,
`firestore.prepareEffect`, `firestore.renew`, `firestore.recordEffect`,
`firestore.complete`, `runner.transition`, `rust.verify_stage_spawn`,
`rust.spawn_io`, `dispatcher.total`, `effect.http.get`, `oidc.client`, and
`oidc.http_request`. Each phase records count and inclusive `totalMs`.
**Do not add the times together:** spans are nested (for example
`dispatcher.total` includes `effect.http.get`, and `runner.transition`
includes `rust.spawn_io`).

Only fixed operation names, duration, outcome, and the native execution ID
are logged. Workflow inputs, URLs, request/response bodies, user/project
IDs and credentials are intentionally excluded. The flag defaults to off.
To disable, set `AWFL_NATIVE_PROFILE_ENABLED=0` in the
Terraform-generated Actions variables and redeploy Jobs. This covers Cloud Run
`/native/execute` requests. Detached executions driven directly by the
persistent GKE scheduler do not currently run through the per-request
`createNativeProfiler` hook and require separate profiling instrumentation.

`NativeGcsReleases.materialize` also supports a bounded per-instance cache of
verified content-addressed executable bytes. Jobs keeps at most four cached
artifacts of up to 8 MiB each, keyed by bucket/prefix/SHA-256. Each use
still verifies its digest and stages a new private executable directory,
which is removed when the worker finishes. The cache is process-local and
does not alter the active release mapping or durable Firestore state.

## Streaming transport benchmark (November 13, 2026)

For the same compiled, SHA-pinned Rust fixture and 100 identical, purely
computational requests:

| Transport | Total (100) | Mean/request |
|---|---:|---:|
| One-shot verify + stage + spawn + remove | 1,928.4 ms | 19.28 ms |
| Persistent JSON-lines process | 19.7 ms | 0.20 ms |

After one warm-up request, streaming used one process for all 100 calls.
The 1,908.7 ms difference is a *matched native invocation benchmark*,
not end-to-end ProjectManager savings. The compiled full ProjectManager
parent completed against real local Jobs in 19.387s / 30 effects / zero
HTTP failures, but the external OpenAI latency varied.

The previously measured 15.074s wall baseline partitions into 12.702s
Jobs HTTP overlapping wall time and 2.372s outside Jobs, including 1.555s
exclusively in repeated Rust subprocess lifecycle. Test harness native
journal was in memory; production Firestore latency is separate.
