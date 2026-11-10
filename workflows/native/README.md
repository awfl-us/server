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
external dispatch. `recordEffect` journals its outcome and `complete` closes
the execution only when no effect remains unresolved.

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

- Introduce a bounded document/subcollection journal for large workflows and
  enforce Firestore document/transaction limits (this prototype stores results
  in one document and is not suitable for unbounded effect counts).
- Implement lease renewal, cancellation, retry/error states, orphan sweeper,
  artifact verification, and a server-side effect dispatcher with allowlists,
  authenticated identity, idempotency, and reconciliation.
- Add compiled Rust worker IPC with checkpoint/resume continuation, source
  manifest validation, and crash/replay tests against Firestore emulator.
- Integrate backend selection **inside** existing `createWorkflowExecution`
  shared launcher; preserve existing session status, links, callbacks and
  monitoring rather than adding a separate executor.
- Add emulator-backed concurrency and transaction contention tests. The
  current tests use a serial in-memory transaction mock.

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

## Cross-repository integration test

Build the `compiler-rust/fixtures/native-fold` binary with Cargo, then run:

```sh
AWFL_NATIVE_FIXTURE_BINARY=/absolute/path/to/awfl_native_fold_77054402 \\
  node --test workflows/native/*.test.js
```

`nativeIntegration.test.js` exercises the **real generated Rust executable**
through `runNativeArtifact` and `executePureNative` (with a mock persistence
adapter). It covers nonempty, empty and signed inputs. Runner negative tests
cover malformed output, nonzero exit, and output overflow. These tests do not
validate Firestore concurrency, durable continuation, remote effects or the
production workflow launcher. They must not be represented as end-to-end
production execution tests.
