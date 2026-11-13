# Native memory-first execution (opt-in)

## Local synchronous subworkflows

`CallOperations.WorkflowRun` is dispatched **within the same Jobs request**.
It uses the IAM-published, SHA-256-verified GCS child release, not another
Cloud Task or Firestore execution. A shared continuation runner invokes the
child and returns its result to the parent; nested calls share the root's
authenticated user/project, external effect handlers, and effect budget.
The child validates *its own* published allowed operations. Child releases
are looked up and staged once per unique name within a root execution.

Use `RunWorkflowArgs(workflow_id, argument, location, project_id)` and the
backend-neutral `CallOperations.WorkflowRun`. Synchronous calls with
`connector_params.skip_polling=false` run locally in the same execution. The requested GCP
project/location must match the executor's trusted deployment; a different
project, arbitrary binary, missing/parallel child release, or detached call
fails explicitly. Nested recursion and total calls are bounded. No new
GKE/Terraform/IAM resources were introduced. Existing Google-specific
connector strings must be migrated to `CallOperations.WorkflowRun` in the
workflow definitions when deploying those workflows natively.

## Independent asynchronous subworkflows

`CallOperations.WorkflowRun` with `connector_params.skip_polling=true` launches
a **separate durable native execution**, not a nested synchronous Rust call.
The parent does not wait. Jobs validates name, GCP project/location and
authenticated identity, resolves the pinned SHA-256 release, and creates
an independent `nativeWorkflowExecutions` record with a deterministic
execution ID derived from the parent's journal idempotency key and the
child name. A retry reuses that ID; different arguments cannot reuse it.
Unlike synchronous children, async releases may contain `native.parallel`.

The bounded in-process scheduler queues the new execution on the persistent
GKE Jobs service and returns `{name:"native/native_...",state:"ACTIVE"}`
without waiting or creating a Cloud Task. Ordinary synchronous children still
run in-process with the parent's journal. At most four detached executions
are active per process.

The Firestore `asyncLaunch` marker stays true while a detached execution
is pending and becomes false on completion, failure or cancellation. GKE
Jobs startup (`AWFL_NATIVE_EXECUTION_ENABLED=1` and
`AWFL_NATIVE_DETACHED_GKE_ENABLED=1`) starts a recovery scan;
subsequent scans run every 15 seconds and reclaim only unleased or
lease-expired executions. Existing native store fencing guards multiple
replicas. Previously dispatched external effects with uncertain outcomes
are **never** blindly retried after a crash.

**Deployment boundary:** This requires persistent GKE Jobs in production.
Cloud Run may freeze a request-scoped process after the parent response,
so the executor rejects detached launches in production until the
persistent GKE opt-in flag is enabled. No Terraform resource or IAM change
was needed. General native production routing remains disabled.

Do not call this a same-process Rust function invocation yet: Rust still
runs in a short-lived subprocess per continuation. The benefit today is
**eliminating per-child distributed scheduling and persistence**. Benchmark
the real compiled parent/child chain before optimizing this boundary.

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

## Stream-capable native binaries

When a pinned release contains `streamIpcVersion:1`, the local child
runner uses the same isolated, verified Rust process across its requests.
The Rust code continues to take full JSON continuation input, and Node
remains responsible for external effects and result persistence. No
user-scoped process reuse, no additional Cloud Task, no DSL changes.
The pool is bounded at sixteen distinct compiled releases per execution
tree; overflow uses one-shot IPC. Old releases remain compatible.
