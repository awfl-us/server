# Server implementation plan: persistent Rust continuation IPC

Updated November 13, 2026. Companion compiler plan:
awfl-us/compiler-rust/docs/persistent-native-ipc-plan-2026-11-13.md.

## Baseline and split (ProjectManager, local GKE Jobs)

- 15,074 ms wall: 12,702 ms overlaps HTTP Jobs calls; 2,372 ms outside HTTP.
- Within non-HTTP time: Rust lifecycle **1,555 ms exclusively**; callbacks
  545 ms exclusively; in-memory execution store 144 ms exclusively.
- 89 native binary invocations cost 2,509 ms *cumulative*, not all additive
  on the critical path. Jobs server processing is independent: 12,617 ms
  cumulative, only ~242 ms less than its client HTTP measured time.
- Production Firestore journal is not included in local measurements.

## Changes

- Preserve one-shot ABI-3 protocol-v2 execution for old binaries; opt-in
  stream support only if a trusted release advertises
  `stream_ipc_version: 1` (server property `streamIpcVersion:1`).
- One verified binary stage + one bounded live process per execution (and
  per parallel lane / synchronous child), sending one JSON-line request and
  receiving one JSON-line response across many continuations.
- Keep process environment sanitized. Do not share instances between users,
  projects or unrelated executions; no spawned shell.
- Limit request/response size, pending requests, memory and lifetime, handle
  malformed output, process death and timeout. Ensure `finally` teardown.
- Keep all existing durable effect journal, leases, auth, callback/child
  protocols, and fork/join. A process restart resumes using persisted
  continuation; the process is not a source of durability.
- Keep existing one-shot fallback, and document capability propagation from
  compiler manifest through deployment/release metadata and execution state.
- Build tests for session reuse, legacy mode, timeout/crash, concurrent lanes,
  child calls and ProjectManager live local execution.
- Re-run per-request timings; preserve separation of Jobs vs native overhead.
  Avoid claiming a speedup from cumulative durations or overlapped spans.

## Constraints

No new GKE, Cloud Tasks or IAM. Any future infra goes through Terraform.
No general production rollout until benchmarks and cross-restart integration.
Implementation should be minimally invasive and maintainable.

## Implemented and verified — November 13

- Streaming is explicitly pinned in the IAM-published release manifest
  (`streamIpcVersion:1`) and in the execution document. Releases
  without this flag use the legacy one-shot native runner.
- Bounded stateless JSON-line process pool: one process per pinned SHA
  within the same authenticated local workflow tree (max 16); each durable
  fork lane has its own stream session. The server verifies the SHA-256
  before staging; temporary executable directories and Rust processes
  are cleaned in `finally`.
- Tests: compiled one-shot and stream compatibility, SHA mismatch,
  invalid request, timeout, distinct ownership, release pinning,
  and original native regression suite.
- The compiled ProjectManager completed the parent execution against the
  real local Jobs Express API in 19.387 seconds (30 effects, no failed
  HTTP calls). Background child completion/recovery in production is not
  yet measured by this one parent run.
- Controlled 100-request *executor-only* comparison: one-shot 1,928.4 ms
  vs stream 19.7 ms; 1,908.7 ms saved (~99% of repeat invocation time).
  This is not the end-to-end improvement; Jobs/LLM costs vary.
- The prior 15.074-second baseline (12.702s Jobs / 2.372s non-Jobs) must
  remain the comparison reference for future controlled full-workflow runs.

No infrastructure/IAM resources were changed and native production routing
was not enabled.
