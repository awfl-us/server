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
  signed/trusted artifact registry, source-manifest validation, sandboxing,
  authenticated identity, real allowlisted HTTP adapters, remote idempotency
  and reconciliation.
- Extend the new single-effect range frame to multiple effect sites,
  nested loops, branches, For, and Fold; current protocol supports top-level
  calls and one direct Call per top-level ForRange iteration.
- Integrate backend selection **inside** existing `createWorkflowExecution`
  shared launcher; preserve existing session status, links, callbacks and
  monitoring rather than adding a separate executor.
- Expand emulator-backed crash injection, transaction contention/throughput
  load tests, and real remote effect adapters. A seven-case real Firestore
  emulator suite passes, including actual compiled Rust suspend/resume.

Local test: `node --test workflows/native/executionStore.test.js`.

## Pure native artifact runner (opt-in library)

`runner.js` verifies the executable's SHA-256, spawns a bounded subprocess,
passes JSON through stdin, and parses JSON stdout. `executePureNative` claims a
fenced execution, checks the pinned artifact and completes it transactionally.
This path only accepts workflows with no checkpoint or pending effect and does
not yet integrate with the production launcher. The caller must select the
executable from a **trusted artifact registry**; this library is not a sandbox
and must not be given arbitrary user-controlled paths or untrusted binaries.
Lease renewal and owner-scoped cancellation are available on the store.
Cancellation fences further persistence but cannot forcibly undo already
executed external effects. Run tests using
`node --test workflows/native/*.test.js`.

## Effect dispatcher boundary

`effectDispatcher.js` accepts explicitly injected operation handlers for the
canonical `http.get/post/patch/delete` identifiers. Unknown operations fail
closed. It uses an execution/effect-scoped idempotency key and only records a
successful handler outcome after the handler returns. A failed/uncertain HTTP
operation remains unresolved in the journal. On recovered leases, the
pre-existing intent is **not** automatically dispatched again: an explicit
operation-specific reconciliation handler must establish the remote result.
These are library-level tests, not production HTTP integrations. Network
allowlists, credentials, remote idempotency and actual HTTP implementations
remain intentionally unprovided until security and replay semantics are tested.

## Versioned native IPC runner (opt-in library)

`executeNativeStep` accepts only a preselected, SHA-verified generated native
binary with protocol version 1 and artifact manifest `runtime_abi=2`.
Top-level calls suspend, returning a stable operation name, arguments,
structural node identifier, result slot and tagged continuation. A real
Firestore transaction persists the pending intent **before** an independent
handler is allowed to dispatch. After `recordEffect` atomically journals the
outcome and binds the slot, the same fenced worker (or a replacement after
lease expiry) resumes the Rust process from the saved top-level position or a validated range invocation frame.

The generated binary never issues network requests. Multiple effects per
iteration and effects inside nested loops/branches,
artifact registry, process sandbox, production authentication, cloud launcher
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
