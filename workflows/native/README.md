# Native workflow execution store (experimental, not deployed)

This is a transactional persistence primitive for the **existing AWFL server**.
It is intentionally not connected to the production workflow launcher or any
HTTP routes. Existing Google Workflows executions remain unchanged.

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

## Recovery and guarantees

A crashed worker leaves a pending intent; a replacement worker receives the
checkpoint and intent but **must not blindly repeat the side effect**. An
external effect dispatcher must use a stable idempotency key, query/reconcile
remote outcomes, or explicitly report uncertainty. Firestore cannot make
arbitrary HTTP side effects exactly once. The fencing epoch protects Firestore
state; it does not stop an already dispatched HTTP request. Persisting a
successful outcome before acknowledging the runner avoids rerunning it after
resume. Unresolved outcomes remain pending until reconciled.

## Next gates before production

- Implement live-slot liveness optimization and external payload indirection
  beyond the current bounded checkpoint/argument/outcome sizes.
- Implement production lease heartbeats, retry/error states, orphan sweeper,
  source-manifest provenance, **OS-level sandboxing**, authenticated identity,
  real allowlisted HTTP adapters, remote idempotency and reconciliation.
- Extend the bounded call-site frames to deeper nested loops/branches,
  For, and Fold. The protocol supports direct Calls in top-level Switch
  branches, direct Calls inside a two-level nested Switch or ForRange,
  and multiple Calls inside one top-level ForRange iteration.
  Previous results are journaled and restored after worker takeover.
- Integrate backend selection **inside** existing `createWorkflowExecution`
  shared launcher; preserve existing session status, links, callbacks and
  monitoring rather than adding a separate executor.
- Expand emulator-backed crash injection, transaction contention/throughput
  load tests, and real remote effect adapters. The Firestore emulator tests
  include actual compiled Rust suspend/resume across both IPC versions.

## Opt-in CFG state machine (runtime ABI 3, IPC protocol 2)

`compiler-rust` also emits a generalized CFG backend via
`RustEmitter.emitV2/writeV2`. It saves a successor **block PC** and the
live tagged slots instead of replaying nested branch or loop frames.
At execution creation, specify `protocolVersion: 2` with an ABI 3 artifact;
omitting it preserves the original v1 protocol. The pinned version is checked
at preparation and against every executable response. A v2 continuation can
resume at CFG PC zero with an empty frame list. The server does not select
the version based on untrusted workflow input.

The generated v2 nested-range Firestore test journals eight distinct
effect invocations and resumes after worker takeover without replay.
Other ABI 3 conformance tests cover effectful For/Fold and mixed nested
branch/loop control flow. Neither backend is connected to the common
production launcher. See `compiler-rust/docs/native-ipc-v2.md`.

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

## Site-owner-only native deployment (experimental, not routed)

Rust compilation/deployment must follow the same trust boundary as Google
Workflows: a trusted CI/release pipeline builds the deployed workflow,
ordinary users can **execute** it but cannot upload, approve, activate,
replace, or withdraw executable artifacts.

`NativeDeploymentService` in `deployments.js` is the server-side deployment
policy and active-version record. It uses the existing **site-owner UID**
configuration, `MCP_OWNER_UID`, **without** the private MCP API-key-owner
fallback. If the site-owner UID is missing, deployment construction fails
closed. Project ownership, project membership, a user-controlled `userId`,
and normal API credentials never confer deployment privileges.

The site owner may call `deploy` / `undeploy` through a future
authenticated, explicitly owner-restricted admin route or trusted release
orchestrator. The `authenticatedUserId` argument must be populated from
the server's verified Firebase/OAuth identity, never directly from client
JSON. Deploy accepts only an approved artifact SHA-256, protocol version,
and workflow name. It *does not* compile Rust, accept binary uploads,
sign artifacts, or grant new capabilities. Before binding the version,
it verifies the artifact against the **CI-signed, read-only registry**.
The binding is stored in Firestore's site-scoped `nativeDeployments`
collection, rather than a user's project.

`resolveActive` can be called on behalf of normal workflow users, without
site-owner deployment rights, to read the active pinned SHA/protocol.
It revalidates the CI signature, publisher and capability set on every
resolution. Changing an active version requires another site-owner
deployment, never a request-body backend selector. The existing shared
launcher integration and admin route have **not** been added yet.

**Production IAM/security-rule requirement:** Firebase client SDKs must have
**no write access** to `nativeDeployments` (nor the signed artifact registry).
Only the trusted server/release identity may write deployment records.
Server-side authorization is not a substitute for this Firestore boundary.
The CI signer must be restricted to the owner-controlled release pipeline,
with protected branch/review policy and workload identity, matching the
existing Google Workflows deployer pattern. Do not enable the deployment
route or shared-launcher selector before these permissions are verified.

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

The generated binary never issues network requests. Effects inside nested
loops/branches, an artifact registry, process sandbox, production
authentication, cloud launcher
integration, retries and remote idempotency remain **unimplemented**.

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

`nativeIntegration.test.js` exercises the **real generated Rust executable**
through `runNativeArtifact` and `executePureNative` (with a mock persistence
adapter). It covers nonempty, empty and signed inputs. Runner negative tests
cover malformed output, nonzero exit, and output overflow. The additional
emulator tests *do* validate Firestore transactions, durable top-level
continuation, and locally mocked effect dispatch; they **do not** verify
remote external side effects or production launcher integration.
