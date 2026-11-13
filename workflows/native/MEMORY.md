# Native memory-first execution (opt-in)

The AWFL DSL already provides explicit caching through
`us.awfl.utils.Cache`, which reads and writes Firebase as workflow steps.
The native runtime therefore **does not automatically persist or deduplicate
every external effect** in memory mode. Idempotency belongs to the workflow.

## Flow

1. Set `AWFL_NATIVE_EXECUTION_ENABLED=1` and
   `AWFL_NATIVE_MEMORY_EXECUTION_ENABLED=1` on the **Workflows API**. The API
   pins `executionMode: 'memory'` in the Firestore launch record and sends
   the mode as an internal hint in its IAM-authenticated Cloud Task.
2. Jobs checks the pinned mode and authenticated owner in one initial
   Firestore claim. It loads the cached, SHA-verified native artifact.
3. Rust JSON continuations, values and effect results remain local to the
   Jobs request. The existing signed Jobs effect handlers still enforce the
   same user/project and OIDC network boundary. No journal document is
   created for individual effects.
4. A tiny coalescing writer may publish occasional progress snapshots in
   Firestore while the request is active. Snapshots are **observational**,
   best effort, and never used as recovery checkpoints; fast workflows can
   finish with zero progress writes. No writes survive request shutdown.
5. Before returning success or a terminal workflow failure, Jobs waits for
   any in-flight progress write, then **awaits the terminal Firestore
   transaction**. The result remains available through the existing
   authenticated `/workflows/execute` polling interface.

An unexpected worker crash is recovered by **starting from the initial
input after lease expiry**, not by resuming an implicit effect journal.
Already executed uncached effects can run again; workflow authors use
explicit `Cache` steps where that matters. A second live delivery cannot
claim the same execution. Cancellation is best effort while an effect is
actively running, and the terminal commit cannot overwrite a cancellation.

Only non-parallel protocol-v2 releases opt into memory mode initially.
Existing executions and parallel-enabled releases stay on the previous
durable worker without changing their persistence semantics. The feature
flag defaults to disabled. Normal production traffic stays Google-backed
until separately enabled and tested. No new IAM, Terraform, Redis,
background service, or Rust subprocess protocol is required.

## Tests

`AWFL_NATIVE_TOOLDEFS_BINARY=/path/to/compiled/helpers-ToolDefs \
AWFL_NATIVE_NESTED_EFFECTS_BINARY=/path/to/compiled/nested-range-effects \
node --test workflows/native/*.test.js jobs/native.test.js`

In addition to the previous durable-worker tests, these cover real compiled
Rust with one and eight HTTP effects, ordered values and no journal
documents, explicit `Try` handler continuation, terminal errors, tenant
scoping, lease takeover/restart, and progress coalescing. Run an isolated
Cloud Run Jobs canary and collect cold/warm measurements before enabling
the new path for regular workflow traffic.
