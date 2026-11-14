# Native memory-first execution (opt-in)

**Production, November 13:** Native Rust routing is live for published
workflows (`AWFL_NATIVE_EXECUTION_ENABLED=1`); Project Manager's
foreground `LIST_DIRECTORY` and final response were verified.
Parallel-capable Project Manager currently uses the **durable native**
worker. The separate memory-mode flag is not enabled for parallel releases.
Unpublished workflows still fall back to Google Workflows.


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
was needed. Normal native production routing is enabled; detached launch remains separately gated.

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

Only non-parallel protocol-v2 releases currently opt into memory mode.
Parallel releases stay on the durable native worker. Memory mode still
defaults to disabled; published releases now use native in production,
while unpublished releases fall back to Google. No new IAM, Terraform,
Redis, background service, or Rust IPC is required.

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


## Memory-first Parallel / ParallelFor — implementation and rollout status

**Difficulty: moderate; primarily server runtime.** Compiled ABI-3/protocol-v2
already supplies `native.parallel`, pinned `parallelVersion:1`,
`pc_<n>` lane entry selectors, captured tagged slots and the join
contract. No DSL or Rust compiler rewrite is expected.

### Implementation

1. Change the four gates together: `backend.js` (opt-in
   mode selection), `executionStore.create()` (permit only a
   memory *root* with `parallelVersion:1`),
   `memoryWorker.js` (accept pinned parallel mode), and
   `localWorkflows.js` (accept parallel root and sync-child
   releases, execute `native.parallel`, and resume lanes from
   validated branch PC/slots instead of an empty continuation).
2. On each fork, capture immutable parent input/slots. Compute
   deterministic virtual lane IDs from root/parent path, fork node,
   generation, and input index. Give each lane an independent
   continuation; share the root's authenticated user/project and
   trusted execution globals. Do **not** create Firestore lane
   documents or per-effect journal entries.
3. Use one bounded in-process concurrency budget, shared by nested
   forks: up to eight active effect-bearing branches, at most 1,000
   lanes/fork and depth three (existing durable limits). A waiting
   parent must not hold a permit while children run. The existing
   stream-process serializes short Rust IPC requests safely, while
   asynchronous external effects still overlap.
4. Join once in memory, preserving results in input-index order
   (`ParallelFor` empty/single/many included). Preserve lexical
   slot isolation and compiled `Try` handlers. On a lane error,
   stop starting unbegun siblings and await already-running ones.
   Do not assert that earlier external effects can be undone.
5. Preserve explicit memory-mode crash semantics: **one root
   Firestore claim, best-effort coalesced progress, one awaited
   terminal commit**. On worker death/expired lease, restart the
   whole tree from input. Uncached side effects from *any* lane
   can recur; the workflow's own `Cache` and idempotent
   handlers own replay protection. Root cancellation/epoch
   fencing still guards terminal commit.
6. Leave existing durable parallel untouched as the default and
   rollback. Only new, explicitly memory-pinned executions may
   use this mode after local tests and isolated Jobs canaries.

### Acceptance

- Run actual generated Rust `Parallel`/`ParallelFor`
  with 0/1/many lanes, nested forks and synchronous children;
  ensure correct index ordering and lexical slot isolation.
- Prove two blocked external handlers overlap; enforce a
  shared permit limit without nested-fork deadlocks. Exercise
  branch errors, outer `Try`, cancellation, timeouts,
  duplicate delivery, and lease takeover.
- Emulator must show zero fork-child documents and zero effect
  journals, with one root claim/terminal commit; progress
  snapshots cannot be mistaken for recovery checkpoints.
- Test a full generated Project Manager cycle locally, then
  benchmark an isolated GKE/Jobs canary versus production
  durable-native and Google; compare tool correctness, Firebase
  calls and user-visible latency before any rollout.

**Not included:** distributed lane workers, durable per-lane
recovery, Terraform/IAM, and detached/background agent behavior.


### Implementation progress — November 13

The feature branch implements memory-first Parallel and ParallelFor using
the existing compiler-generated ABI 3/protocol 2 fork selectors, tagged
captured slots, and ordered join outputs. The added
memoryParallel.js scheduler shares one eight-effect concurrency budget
across nested forks, while localWorkflows.js handles independent
branch continuations and stable virtual lane identities. Repeated fork
instructions and workflow calls inside loops get deterministic
per-invocation ordinals rather than globally shared ordering.

A detached workflow.run with skip_polling=true still launches a
*separate durable execution*, with its own Firestore root record and
persistent GKE dispatch, so its lifetime does not depend on the parent.
Detached children are distinct from in-memory parallel lanes.

Real compiled Rust fixture tests cover Parallel, ParallelFor (0/1/many),
nested branches, overlapping effects, caught and uncaught branch Raise,
and root-only persistence with no branch documents or effect journals.
A real Firestore emulator integration test was added to the native CI
suite, with duplicate-delivery fencing checks.

The local Project Manager test runner now supports --memory. The
development GKE consumer hit PERMISSION_DENIED on the real Jobs Firebase
write, an existing local IAM limitation rather than a native compiler
or fork/join failure. Do not grant broader development credentials to
bypass this requirement: an isolated authenticated Jobs canary is the
appropriate final end-to-end test.

This implementation is gated and **not enabled in production**.
The production Project Manager remains on durable native parallel.
Before enabling memory mode for production Project Manager, complete
isolated real-Jobs canary tests and compare latency/Firestore call counts.
Cache-based recovery and potential repeated uncached side effects on a
worker crash remain intentionally different from durable mode.


### Isolated production canaries passed — November 13, 2026 ET

[Server PR #112](https://github.com/awfl-us/server/pull/112)
(merge 83578ab) deployed successfully with the ordinary
[server production release](https://github.com/awfl-us/server/actions/runs/43540051941).
API, Jobs and the GKE native worker updated. **The API memory-mode flag is
still unset: normal Project Manager sessions remain on durable native.**

After the successful release, we created **isolated, manually
memory-pinned production Firestore roots**, queued through the existing
Cloud Tasks queue and IAM-authenticated Jobs/OIDC using the published
26-artifact Project Manager closure. No global routing flag, Terraform,
IAM, or existing execution was altered.

- **No-tool canary:** real GPT-5 Project Manager, BENCH_OK, **13.22 seconds
  client-observed** (12.99 seconds lifecycle), 59 native effects,
  successful terminal result and **zero Firestore effect journals**.
- **Real-tool canary:** called LIST_DIRECTORY once, received actual
  workspace entries (Cargo.lock, Cargo.toml, LICENSE); memory-root
  completed in **19.87 seconds** (19.54 seconds lifecycle), 68 effects
  and **zero engine effect journals**. The independent detached
  follow-up ran as a durable child, returned the correct files,
  and reached Done without error. User-message-to-final-answer time
  from session timestamps was **37.57 seconds**.

Earlier durable-native Project Manager tests took 31.26 seconds
for the BENCH_OK lifecycle and 49.43/51.66 seconds from user
message to final reply for the same directory task. These are
limited, non-randomized comparisons with variable OpenAI model
latency and different launch paths; they are functional canaries,
not proof of precise performance improvements. The canaries
were seeded directly via authenticated Cloud Tasks/Jobs rather
than the public Workflows API. Real Firestore emulator tests
independently verified **zero memory fork documents** and
zero engine effect journals.

**Rollout decision:** leave the API memory flag off by default
for ordinary sessions while retaining the durable executor and
Google fallback. A scoped production rollout and repeated
same-API A/B test remain follow-ups, with the explicit-cache
crash/replay contract documented above.
