# Native Rust workflow execution (experimental, opt-in)

**Verification checkpoint (November 11, 2026).** Compiler-rust PRs #1–#7
and server PRs #72/#78/#79 are **merged**; PR #7 fixes catch-only CFG and
PR #79 adds restricted `log.write`, capability gates and real Rust/Node error
journaling and crash-after-commit coverage. GitHub CI passed for both. The
normal native routing flag is still **off**: merging code does not constitute
a live-effect canary or production rollout. See the [cross-repository
readiness matrix, evidence and ordered gates](https://github.com/awfl-us/compiler-rust/blob/main/docs/current-state-and-roadmap.md).

**Parallel implementation checkpoint (November 12, 2026; draft PRs).**
Compiler-rust #18 and server #82 now support real compiled Rust
`Parallel`/`ParallelFor` child entrypoints, pinned child records, concurrent
native effect dispatch, parent fork journaling, deterministic joins, and
reconciliation after a crash between child completion and parent journaling.
The compiled parent `Try` catches only confirmed child failures; uncertain
remote outcomes remain unresolved. The in-process per-root permit budget
bounds nested worker activity, but is not a distributed/global Jobs quota.
The currently passing integration tests use a transaction-shaped Firestore
substitute, **not the Firestore emulator or deployed Cloud Tasks/Jobs**.
Cancellation, distributed concurrency admission, realistic workflow parity,
and live canary testing remain gates. Native production routing stays off.


The existing AWFL Workflows service has an optional native Rust execution
backend. `createWorkflowExecution` chooses it only when
`AWFL_NATIVE_EXECUTION_ENABLED=1` **and** a release exists for the exact
workflow name in the IAM-controlled GCS artifact bucket. Otherwise the same
Google Workflows execution path is used unchanged. The feature is disabled by
default. The public Workflows API authenticates the caller; an OIDC-signed Cloud
Tasks request reaches the existing IAM-protected Jobs service, where execution
state, owner, artifact digest, and effect capabilities are pinned in Firestore.
No user-provided artifact path is accepted, and native binaries receive no GCP
authentication material.

Provisioning is defined in `infra/native-execution` (independent GCS Terraform
state) and in `awfl-us/workflows` (native artifact bucket and IAM). A pure
`NativePilot` ABI 3/protocol 2 release is published for controlled live tests.
This is **not** general production parity: the trusted HTTP adapter and
confirmed HTTP failure-to-`Try` recovery are implemented and locally tested,
but **live external HTTP behavior**, arbitrary DSL control flow, callbacks,
child workflows, `Parallel`, and OS process isolation remain gated below.

`NativeExecutionStore` accepts a Firestore instance; callers must authenticate
and authorize the `userId`/`projectId` before creating or reading executions.
A pinned artifact SHA-256, schema version, execution ID, and typed input are
recorded once. `claim` grants a time-limited worker lease with monotonically
increasing epoch; all writes require the current unexpired epoch. Checkpoints
persist the next resumable node and tagged slots at **effect boundaries**, not
per pure instruction. `prepareEffect` persists the intended effect before
external dispatch. `recordEffect` writes the outcome into a dedicated Firestore
`effects/{effectId}` subcollection document **in the same transaction** as
updating the resumed slot and clearing the prepared intent. The root execution
document stores an effect counter, not an ever-growing outcome map.
`complete` closes the execution only when no effect remains unresolved.
Input, checkpoint, effect-argument, outcome and result size limits fail closed.

## Compiled Try/Raise and confirmed effect errors (ABI 3 / IPC v2)

The Scala-to-Rust compiler now uses the *existing*, unchanged DSL `Try` and
`Raise` constructors. Its compiled CFG statically links nested exception
handlers, preserving the nearest catch and propagating explicit re-raises to
outer handlers. Pure CEL value failures are handled inside the trusted Rust
process; malformed native continuations and infrastructure errors remain
uncatchable. Unhandled workflow raises produce `status: failed` and are
persisted as terminal `Failed` executions; the existing owner-checked
status API exposes the error, and further dispatch/cancellation is rejected.

When a compiled `Try` encloses a native HTTP effect, its suspended effect
intent can contain `on_error: {next_step,error_slot}`. The server validates
and pins this handler with the effect fingerprint. **Only a definitively
received HTTP 400–599 response** is a catchable failure: the restricted HTTP
adapter returns `NativeConfirmedHttpFailure`, and the authorized dispatcher
calls `recordEffectFailure`. Under one Firestore transaction with the current
lease epoch, this method journals the failure, stores the tagged error object
(`message`, `code`), switches the checkpoint to the compiled catch PC,
clears the pending intent, and increments `effectCount`. A duplicate delivery
cannot redispatch an already journaled failure or rewrite a different result.

Socket timeouts, unknown remote outcomes, redirects, transport exceptions,
permission failures, invalid state and unreconciled effects **never** enter
a compiled catch handler. They remain unresolved for reconciliation. The
handler does not retry an ambiguous external operation, and these additions
do not enable native routing in Cloud Run. This is a *locally verified*
IPC/Firestore-store integration, **not** a production approval of real HTTP
transports, OS-level sandboxing, full exception parity or network behavior.

Local tests: `node --test workflows/native/*.test.js` exercises the journal
and dispatcher. To run the full compiled-binary integration, set the paths of
`compiler-rust` generated `effect-catch` and `uncaught` Rust binaries in
`AWFL_NATIVE_TRY_CATCH_BINARY` and `AWFL_NATIVE_UNCAUGHT_BINARY`, and run
`node --test workflows/native/nativeTryIntegration.test.js`. The ordinary
server tests skip only that binary-dependent test when those env vars are
absent. The compiled Rust binaries and mock/real persistence API are tested
together; no network requests are issued.

## Native built-in `Log` effect: trusted server-only output

The original Scala DSL's default `Try` handler calls `sys.log` before
re-raising. The Rust compiler translates that exact DSL-owned call to the
canonical `log.write` effect. The server's artifact/execution allowlists now
permit `log.write`; the dispatcher implements it via a restricted local
structured logger (the existing `createJobsEffectHandlers` factory). **No**
HTTP request, shell command, or arbitrary dynamic code is dispatched.

The merged logging adapter requires an authenticated workflow owner/project,
a valid stable effect idempotency key, and exactly one nonempty `text` argument no larger than
4 KiB as UTF-8. It emits an `INFO` log with Cloud Logging insertId equal
to the stable execution/effect identifier. The standard fenced Firestore
effect journal stores `null` as the successful log result; the generated Rust
can then resume and re-raise the original DSL error. Unknown operations and
cross-tenant invocations fail closed. Log delivery is **not exactly once**:
a crash after log emission but before journal commit could repeat the log.
The stable insertId allows downstream deduplication; only the checkpoint
transition and terminal failure are durable/idempotent.

`logEffects.test.js` tests accepted/rejected payloads and lease/authorization
checks. `nativeTryIntegration.test.js` runs a **real generated Rust binary**
through the Node worker and Firestore-compatible execution store: it verifies
`log.write` journaling, original error propagation, terminal `Failed`,
tenant isolation, and crash recovery after the journal commit without
re-dispatching. Compiler PR #7 adds the generated `default-log` fixture to
`TryRaiseSmoke`; merged server PR #79 CI compiles the **pinned merged compiler
commit** before invoking Node. The locally executed focused server selection returned
**37 total / 34 pass / 0 fail / 3 optional other-binary tests skipped**.
It includes a simulated worker crash **after** the effect journal commit;
resumption did not invoke `log.write` a second time, and the original error
remained terminal. This **does not** validate a pre-journal emission crash,
live Cloud Logging ingestion, or actual Firestore contention. No live network
calls were issued; production native routing remains disabled.

## Recovery and guarantees

A crashed worker leaves a pending intent; a replacement worker receives the
checkpoint and intent but **must not blindly repeat the side effect**. An
external effect dispatcher must use a stable idempotency key, query/reconcile
remote outcomes, or explicitly report uncertainty. Firestore cannot make
arbitrary HTTP side effects exactly once. The fencing epoch protects Firestore
state; it does not stop an already dispatched HTTP request. Persisting a
successful outcome before acknowledging the runner avoids rerunning it after
resume. Unresolved outcomes remain pending until reconciled.

## Next gates before production (in dependency order)

1. **Land the current compiler/server pair.** Require green compiler PR #7
   (Scala, Cargo, full CLI/CFG/real-workflow tests and strict Clippy). In the
   separate server `log.write` PR, pin CI to the final merged compiler commit,
   generate real Rust in CI, and execute the native worker integration tests
   for log journaling, terminal error, tenant scope and crash-after-commit.
   No normal traffic flag change.
2. **Create real-workflow and Google differential coverage.** Maintain an
   instantiated-AST inventory of CEL functions/Calls/raw source, including
   helper closures. Run unchanged `LoadConversationHistory`/`Product` and
   increasing workflow graphs against deterministic backend comparisons;
   record missing features and exact value/error/retry behavior.
3. **Complete server-side effect reliability.** Audit HTTP retry and uncertain
   remote outcomes, reconciler, safe remote idempotency, worker lease renewal,
   crash windows before/after an external effect, orphan sweeping, Firestore
   throughput, cancellation and per-execution status. Add callback inbox,
   child execution, and storage/Pub/Sub adapters with explicit result shapes.
4. **Implement durable parallel orchestration.** Compiler-private lowering
   for original DSL `Parallel`/`ParallelFor` plus server-owned bounded branch
   scheduling, isolated slots, crash-safe join, cancellation/error propagation
   and tested ordering. Do **not** flatten parallel constructs sequentially.
5. **Protect and roll out.** Run ELF processes in a sandboxed container/job
   without credentials or broad network/filesystem access; verify IAM/OIDC,
   GCS manifest provenance, authenticated public launcher/session workflows,
   status/cancellation, benchmark p50/p95/p99 versus Google with equal
   durability, and demonstrable active-artifact rollback before canary traffic.

The original pure test canary's **6,836 ms** enqueue-to-completion observation
was one cold-start-including sample; it is not proof of native speedup.
The public Google execution path must remain available for existing runs.
For phase owners/gates and exact feature matrix use the compiler's
[current-state-and-roadmap.md](https://github.com/awfl-us/compiler-rust/blob/main/docs/current-state-and-roadmap.md).

## Authenticated native execution identity

New ABI 3 / protocol-v2 native binaries can accept a bounded
`trusted_globals` field containing the four built-in Google Workflows
identity values. This field is emitted **only** for releases that declare
`trustedGlobalsVersion: 1` in IAM-authored metadata, which is pinned in
Firestore when execution starts. Existing ABI-3/protocol-v2 artifacts have
strict request decoding and must not receive new keys; their requests
remain unchanged. The Jobs runner derives these **only** from the persisted
execution's immutable name/ID and server-owned `GCP_PROJECT` (or
`GCLOUD_PROJECT`) and `WORKFLOWS_LOCATION`. It deliberately never
uses the AWFL tenant `projectId` or caller-provided `input.env` as
authority for those values. This is separate from ordinary workflow
input and from the already-journaled result slots.

The Rust program does not authenticate requests itself: that must remain
the Workflows API -> IAM/OIDC Jobs -> owner-matched Firestore execution
boundary. A deployed Jobs runtime without a configured Google project
does not claim to provide trusted built-ins; generated code requiring
them fails closed. No service-account credentials or secret environment
values are forwarded to the ELF, and production native routing remains
opt-in and disabled by default. The companion compiler-rust change
validates the four keys and allows `sys.get_env` only for these built-ins
plus explicit string defaults. Unknown environment lookups cannot read
the process environment.

## Opt-in CFG state machine (runtime ABI 3, IPC protocol 2)

`compiler-rust` emits one generalized CFG backend via
`RustEmitter.emit/write` (ABI 3/IPC v2). It saves a successor **block PC** and the
live tagged slots instead of replaying nested branch or loop frames.
At execution creation, specify `protocolVersion: 2` with an ABI 3 artifact;
omitting it preserves the original v1 protocol. The pinned version is checked
at preparation and against every executable response. A v2 continuation can
resume at CFG PC zero with an empty frame list. The server does not select
the version based on untrusted workflow input.

The generated v2 nested-range Firestore test journals eight distinct
effect invocations and resumes after worker takeover without replay.
Other ABI 3 conformance tests cover effectful For/Fold and mixed nested
branch/loop control flow. Only IAM-published protocol-v2 releases are eligible
for the opt-in shared production launcher. See
`compiler-rust/docs/native-ipc-v2.md`.

Local test: `node --test workflows/native/executionStore.test.js`.

## Pure native artifact runner (opt-in library)

`runner.js` opens the executable without following symlinks, verifies its
SHA-256, copies the verified bytes into a private temporary directory, and
executes that immutable snapshot instead of the original mutable source
path. It strips the inherited environment (including token paths and GCP
secrets), sets a private working directory and enforces input/output/time
limits. `executePureNative` claims a
fenced execution, checks the pinned artifact and completes it transactionally.
This path only accepts workflows with no checkpoint or pending effect and does
not yet integrate with the production launcher. The legacy raw-path
`runNativeArtifact` / `executeNativeStep` APIs are for trusted internal
callers and tests; they must never accept executable paths from user input.
Lease renewal and owner-scoped cancellation are available on the store.
Cancellation fences further persistence but cannot forcibly undo already
executed external effects. Run tests using
`node --test workflows/native/*.test.js`.

## Signed artifact registry (experimental, not deployed)

`artifactRegistry.js` implements a read-only, Ed25519-signed approval gate.
`executeRegisteredNativeStep` reads the execution's *pinned* SHA-256 and
protocol version from Firestore, asks the registry to resolve that exact
artifact, and enforces the approval's declared effect-operation capabilities.
It never accepts a user-supplied executable path.

Release tooling must provision the following files into an **administrator-
controlled, non-group/world-writable** directory:

- `<sha256>.bin`: the approved native Linux ELF executable
- `<sha256>.approval.json`: a JSON envelope with `manifest` and `signature`

The signed `manifest` has exactly these fields:

```json
{
  "schemaVersion": 1,
  "publisherKeyId": "trusted-ci",
  "artifactSha256": "<64 lowercase hex characters>",
  "protocolVersion": 2,
  "runtimeAbi": 3,
  "allowedOperations": ["http.post"]
}
```

`signature` is the base64-encoded Ed25519 signature over the UTF-8 bytes of
`JSON.stringify(manifest)`. The public keys in `trustedPublishers` must come
from trusted server deployment configuration, **not** from the approval file
or workflow input. The signing private key must remain exclusively in the
release service. The registry reads files without following final-component
symlinks, validates the signature and hashes the opened binary; the runner
revalidates and snapshots the bytes again before launching.

The special `allowScriptsForTests` registry option is only for isolated
test fixtures; the default rejects any approved binary without an ELF
header. Unit tests cover forged approvals, wrong signer/protocol, content
replacement, symlinks, stripped environment, and capability mismatch.
The native ABI 3 Firestore test runs a **real** Rust executable through the
signed registry, records eight effects, and survives worker takeover.

**Security boundary:** private staging and environment scrubbing are *not*
an operating-system sandbox. The current worker still shares its UID,
filesystem namespace and network permissions with the native process.
Never run user-supplied/untrusted compiled code in the server container.
Before production use, run approved binaries in a separate restricted
container/job with dedicated service identity, filesystem and network
isolation, no mounted GCP credentials, bounded CPU/memory/process resources,
and audited artifact provisioning. This code does not yet create or
enforce such a container.

## Deployment authority and existing service trust boundary

Native Rust deployment follows **existing Google Cloud IAM**, just like the
Google Workflows deployment pipeline. There is **no AWFL site-owner role,
MCP owner check, API-key permission, or separate native deployment API**.
People and CI identities with the necessary GCP IAM privileges deploy compiled
workflow artifacts to GCP-managed resources. Existing Workflows deployment uses
`workflows/.github/workflows/deploy-workflows.yml` with GitHub OIDC workload
identity and a dedicated GCP deployer service account.

The former `NativeDeploymentService` with a `MCP_OWNER_UID` check and
Firestore write methods was removed: it duplicated GCP authorization and
introduced a deployment capability in the application layer. Any future
artifact publication and activation must take place using an IAM-authorized
GCP deployment path, **not** an endpoint authenticated only as an AWFL user.
The server/runner may **read** the published artifact mapping, verify the
artifact digest/approval, and execute a pinned artifact, but must never accept
workflow binaries or deployment aliases supplied by an end user.

**User execution is deliberately different from deployment.** Users
authenticate to the existing public `/workflows/execute` endpoint with
Firebase/OAuth credentials (`clientAuth`); the API derives `req.userId`
from that authentication. The shared `createWorkflowExecution` service passes
that trusted `userId` and `projectId` as workflow environment values, overriding
caller-provided `env`. The authenticated **Workflows service** launches the
workflow using its GCP execution permissions; end users do not receive
permissions to invoke Google Workflows or the Jobs service directly.

The Jobs service is deployed with `--no-allow-unauthenticated`. The
**Cloud Run IAM/OIDC boundary must authenticate the invoking workflow/service
identity**; only *after* that boundary does `jobs/userAuth.js` trust the
forwarded `userId` without independently verifying the user's Firebase token.
For native workflows, preserve this exact split: accept requests only through
the existing authenticated Workflows API, use the same shared launcher and
persisted execution/status mechanisms, and invoke Jobs from the trusted server
context with that authenticated user's ID. Never expose a direct native
execution endpoint or forward an unverified client-supplied user ID to Jobs.

### Opt-in GCS artifact lookup and shared launcher

The Workflows Terraform root defines a dedicated, private bucket:
`<project>-native-workflows`. GitHub Actions in `awfl-us/workflows` uses
the existing GCP Workflows deployer IAM and WIF identity to publish
content-addressed Rust binaries under `native-workflows/artifacts/` and
replace the active mapping under `native-workflows/active/`. This bucket is
**not** used for shared cloud-environment storage.

`gcsReleases.js` reads the GCS mapping with the server runtime's **read-only**
IAM, verifies its schema and the pinned SHA-256 of the ELF executable, and
never uploads or edits releases. `createWorkflowExecution` conditionally
selects the native backend when `AWFL_NATIVE_EXECUTION_ENABLED=1` and the
workflow has a published native mapping. Otherwise, the existing Google
Workflows launcher is unchanged. No AWFL user deploy permission was added.

The native path stores the authenticated `userId` and `projectId` alongside
the pinned digest, creates a single GCP Cloud Task, and invokes the existing
Cloud Run Jobs service. Its GHA deployment uses
`--no-allow-unauthenticated`: Cloud Run IAM verifies the invoking OIDC
service identity **before** the Jobs middleware trusts the forwarded user
ID. Native Jobs adapters overwrite any workflow-supplied `body.userId` and
`body.projectId`, since the middleware checks body before headers.
The same existing status/cancellation endpoints recognize native IDs.

This backend remains **off by default**. The artifact bucket and the
native Cloud Tasks queue/IAM were provisioned with Terraform: the existing
Workflows tracked state owns the bucket; the separate
`server/infra/native-execution` GCS-backed state owns the queue and Jobs
invoker grants.

### November 11, 2026: live pure native canary

- Server [PR #72](https://github.com/awfl-us/server/pull/72) is merged and
  deployed (API revision `api-00137-hjd`, Jobs `jobs-00119-7gr`). Both
  ordinary revisions have `AWFL_NATIVE_EXECUTION_ENABLED=0`.
- A **zero-traffic** Jobs revision, `jobs-00121-jaz`, was created with native
  execution enabled, tagged `native-rust-pilot`. The production Jobs revision
  retains **100% of regular traffic**. OIDC's audience remains the canonical
  Jobs service origin even when the task targets the tagged URL.
- The initial published pilot executable used the glibc interpreter
  `/lib64/ld-linux-x86-64.so.2`, which Alpine Jobs lacks. The real Cloud
  Task reached Jobs, but `spawn` failed with `ENOENT`; retries returned
  `503` / valid-worker `lease held`. The failed task was deleted.
- Workflows [PR #3](https://github.com/awfl-us/workflows/pull/3)
  merged a publisher that compiles and verifies **static**
  `x86_64-unknown-linux-musl` ELF binaries and executes them in
  `node:22-alpine` CI. The verified pilot artifact was republished at SHA-256
  `109b82a73175a46ada8b4c5f5059b724f40017a8321b2c76edec9e62396f984e`,
  with `protocolVersion: 2`, `runtimeAbi: 3`, `allowedOperations: []`.
- A second **real** Cloud Tasks → tagged Jobs → Firestore canary completed:
  execution `native_1432d417a1464e5dbc11af93e00e9f3f`, result
  `[2,3,9,9]`, observed enqueue-to-completion **6,836 ms** (single
  sample, not a production latency percentile). Duplicate task delivery
  preserved the completed result and execution epoch. The scripted test is
  `compiler-rust/scripts/live_native_pilot.py`.

**Limits of this evidence:** the canary directly initialized a trusted
Firestore execution and submitted Cloud Tasks using the injected GCP
credential. It **did not** exercise Firebase-authenticated
`POST /workflows/execute`, agent session/history/callback registration, or
real HTTP effects. The GitHub App's manual workflow-dispatch attempt
returned HTTP 403; the approved, Alpine-tested CI artifact was published
through an existing GCP IAM identity instead. Verify the authorized release
workflow in its intended deployment context before relying on automated
publication. Do not enable general native routing until real HTTP effect
reconciliation, OS confinement, crash/retry policy, and workflow parity are
verified. Keep the normal Jobs revision at native=0 until those gates pass.

## Effect dispatcher boundary

`effectDispatcher.js` accepts explicitly injected operation handlers for the
canonical `http.get/post/patch/delete` identifiers. Unknown operations fail
closed. **An `authorizeExecution` callback is now mandatory**, even for
reconciliation. The trusted caller's policy must verify the stored execution
owner and project against the authenticated worker/application context and
return an explicit `{ allowed: true, userId, projectId }` decision.
Missing, denied, or mismatched decisions reject dispatch without invoking a
handler. The dispatcher rechecks the live worker epoch, lease and pending
intent *after* the asynchronous policy call. Only sanitized `userId` and
`projectId` are forwarded to handlers, never arbitrary policy-returned
credentials. Disposable emulator tests use an explicitly permissive fixture
policy; no production identity provider is configured yet.

It uses an execution/effect-scoped idempotency key and only records a
successful handler outcome after the handler returns. A failed/uncertain HTTP
operation remains unresolved in the journal. On recovered leases, the
pre-existing intent is **not** automatically dispatched again: an explicit
operation-specific reconciliation handler must establish the remote result.
These are library-level tests, not production HTTP integrations. Network
allowlists, credentials, remote idempotency and actual HTTP implementations
remain intentionally unprovided until security and replay semantics are tested.

## Policy-constrained HTTP effect adapters (no live transport)

`httpEffectHandlers.js` creates canonical `http.get/post/patch/delete`
handlers only for explicitly configured, exact-match public HTTPS origins,
allowed methods and path prefixes. It rejects IP literals, URL credentials,
non-HTTPS URLs, custom ports, encoded path ambiguities, and workflow-supplied
authentication or headers. It bounds JSON request/response payloads and
forbids redirects; HTTP errors remain unresolved effects rather than being
silently journaled as successful responses.

Credential acquisition is server-side through an injected
`credentialProvider` using the authenticated user and project. No credentials
are read from workflow input or passed into compiled executables. Each
request carries the stable execution/effect idempotency key. Handlers return
`{code, body}` on successful HTTP responses. Full Google Workflows HTTP
response, retry and exception parity is still pending.

**There is deliberately no default `fetch` implementation.** The caller must
inject a separately reviewed `transport.sendRequest` implementing pinned
DNS/IP routing, network egress restrictions, abort/timeout handling,
no redirects, and response-byte limits. Application-level origin matching
cannot prevent DNS rebinding without those controls and a restrictive
container network policy. Tests use a fake transport only; no real network
or cloud credentials are exercised. The adapter remains unconnected to the
production launcher.

## Versioned native IPC runner (opt-in library)

`executeNativeStep` accepts only a preselected, SHA-verified generated native
binary with protocol version 1 and artifact manifest `runtime_abi=2`.
Top-level calls suspend, returning a stable operation name, arguments,
structural node identifier, result slot and tagged continuation. A real
Firestore transaction persists the pending intent **before** an independent
handler is allowed to dispatch. After `recordEffect` atomically journals the
outcome and binds the slot, the same fenced worker (or a replacement after
lease expiry) resumes the Rust process from the saved top-level position or a validated range invocation frame.

The generated binary never issues network requests. Nested effect execution
is supported by the opt-in ABI 3 state machine, while `Try`/`Parallel`
parity, process-level isolation, production retry/reconciliation and
live remote side-effect validation remain **unfinished**.

For isolated local tests use `node --test workflows/native/*.test.js`.
To run the real Firestore emulator tests, start an emulator on localhost and
set `FIRESTORE_EMULATOR_HOST`; tests with no emulator skip instead of touching
live Firestore. Optional environment variables enable the real compiled Rust
cross-repo integration fixtures:

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8099 \
AWFL_NATIVE_FIXTURE_BINARY=/absolute/path/to/native-fold-binary \
AWFL_NATIVE_PROTOCOL_BINARY=/absolute/path/to/native-resume-binary \
AWFL_NATIVE_MULTI_BINARY=/absolute/path/to/native-two-effects-binary \
AWFL_NATIVE_RANGE_BINARY=/absolute/path/to/native-range-effect-binary \
AWFL_NATIVE_MULTI_RANGE_BINARY=/absolute/path/to/native-range-two-effects-binary \
AWFL_NATIVE_SWITCH_BINARY=/absolute/path/to/native-switch-effects-binary \
AWFL_NATIVE_NESTED_SWITCH_BINARY=/absolute/path/to/native-nested-switch-effects-binary \
AWFL_NATIVE_NESTED_RANGE_BINARY=/absolute/path/to/native-nested-range-effects-binary \
AWFL_NATIVE_V2_NESTED_RANGE_BINARY=/absolute/path/to/native-v2-nested-range-effects-binary \
AWFL_NATIVE_PILOT_BINARY=/absolute/path/to/published-NativePilot-ABI3-binary \
node --test --test-concurrency=1 workflows/native/*.test.js
```

Run these only with disposable, isolated emulator project IDs. A lightweight
`AWFL_FIRESTORE_CLIENT_ROOT` override is supported for cloud test
environments that install the `@google-cloud/firestore` client without
the complete server `node_modules`; production builds use
`firebase-admin` normally.

## Cross-repository integration test

Build the `compiler-rust/fixtures/native-fold` binary with Cargo, then run:

```sh
AWFL_NATIVE_FIXTURE_BINARY=/absolute/path/to/awfl_native_fold_77054402 \\
  node --test workflows/native/*.test.js
```

`nativeIntegration.test.js` exercises **real generated Rust executables**
through `runNativeArtifact`, `executePureNative`, and the protocol-v2
`runNativeWorkflow` worker (with mock persistence adapters). The pilot binary
test verifies its fixed result `[2,3,9,9]`, completion, duplicate task
redelivery, and owner isolation. The older fold fixture covers nonempty, empty
and signed inputs. Runner negative tests
cover malformed output, nonzero exit, and output overflow. The additional
emulator tests *do* validate Firestore transactions, durable top-level
continuation, and locally mocked effect dispatch; they **do not** verify
remote external side effects or production launcher integration.
