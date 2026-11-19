# Local native reconciliation harness: server-side integration

**2026-11-19; feature branch `feat/reconciliation-test-harness`; no production deployment.** Paired with `awfl-us/workflows` `feat/reconciliation-test-harness`, main guide at `docs/reconciliation-local-testing.md`.

## Current implementation

- Extend existing `scripts/nativeLocalDev.mjs` (test/dev runner only) with optional `respondHttp` for semantic HTTP fixtures, `storageHandler` for restricted file-content reads, `callbackFixtureHandlers` for deterministic callback returns, and `drainDetached` to wait for the real native scheduler's children.
- New `scripts/reconcileScenario.mjs` feeds the actual native ProjectManager Rust closure deterministic Jobs/LLM/callback/GCS responses, with fake document persistence and no external OpenAI/Postgres/network requests. It fails closed on unknown endpoints and retains existing Jobs-origin and trusted execution identity checks.
- `scripts/reconcileScenario.test.mjs` tests mocks independently. The workflows CLI invokes both these tests and the pre-existing native-local suite, then native `basic`/`no-query` scenarios.

## Observed outcomes and outstanding blockers

- Native closure: **26** verified static musl binaries, `publish=false`. `basic`: 32 root effects, one mock LLM response, one persisted user and one assistant message. `no-query`: 30 root effects, seeded user history and **no extra synthetic user message**. Approx 400–500 ms warm runs.
- Native root completions pass. **Strict detached background test fails**: three nested topic/summarization/chain executions fail with `unsupported subtraction operand types`. Earlier empty segment fixture caused a different list-index failure; mocked `segmentsForSession` and nested `StriderInput.segmentEnd`/window are suspects. Do not claim this proves a production incident until fixture parity is verified. Strict mode detects the failure instead of silently accepting the foreground status.
- Isolated local PostgreSQL + real Jobs Express service is the next **separate** fidelity tier. Current in-memory durable native execution and mock route responder do **not** exercise Postgres or real Jobs handlers, and should never be pointed at production `awfl_prod`.

## Next implementation gates

1. Verify `segmentsForSession` and nested `StriderInput` shapes against current real Jobs endpoints and native child input; make strict background mode pass with no false positives. Add targeted async scheduler tests ensuring it is drained in assertions.
2. **Completed standard READ_FILE roundtrip.** Extend with missing/delayed callbacks, malformed tool outputs, incorrect tool-call IDs, budget exhaustion and native crash/recovery assertions.
3. Stand up an isolated Postgres DB and local Jobs on localhost:5055 with test-only user/project and LLM responses; validate actual Postgres persistence/locking and retry using existing storage tests. Never widen GCP IAM to get local tests to pass.
4. After local checks, compare one isolated canary to production-shaped behavior; measure response, usage, context capture, cache and error telemetry. No Google Workflows.

## Isolation guarantees

Feature code only touches local `scripts/` runners and docs; no production route, model, storage or IAM behavior is modified. The new fixture does not make external requests and rejects unknown routes. The runner still requires explicit identity/project; native child identity and Jobs-origin checks remain active. Do not add fixture fallbacks to production worker code.

## Verified follow-up — 2026-11-19

The complete Project Manager native closure (26 static ELF binaries) passes
`basic`, `no-query`, and `tool-roundtrip` with `--strict-background` once
`compiler-rust` supports mixed Float/Integer subtraction. Initial failures
were a real native arithmetic incompatibility (timestamp float minus window
integer), followed by a **fixture-only** invalid JSON response for background
`response_format=json_object`. The fixture now returns schema-shaped JSON per
background workflow and differentiates model calls by `workflow_name`.

Verified: basic/no-query each run one foreground and five background mocked
LLM calls; READ_FILE tool roundtrip runs two foreground and ten background
calls; all three report zero failed detached executions. The harness fails
closed for unknown routes and background response schemas.

These are local native/in-memory fixtures. Persistent Postgres, real Jobs HTTP,
crash recovery and live OpenAI/prompt-cache comparison remain untested.

## Phase 0 real PostgreSQL / process-restart follow-up — 2026-11-19

- `scripts/compose.reconcile-postgres.yml`: optional localhost-only PostgreSQL 17 for reproducible local tests, fixed dev-only database `awfl_reconcile` and password, named volume. In the Scala GKE consumer, a user-owned local PostgreSQL 17.12 was started from Debian packages (Docker unavailable). No Cloud SQL or live Firebase credentials were used.
- `scripts/reconcilePostgresNative.test.mjs`: three tests execute the **real compiled** `helpers-ToolDefs` native ELF with `NativeMemoryExecutionPilotStore` and `PostgresAtomicRecords`, exercise actual localhost HTTP requests through `createLocalJobsHttpHandlers`, SQL persisted completion/replay, subprocess SIGKILL/expired lease fencing, and a crash after HTTP return but before terminal state commit. Effect idempotency key is preserved across retry; test endpoint deduplication is required for a single logical effect. `scripts/reconcilePg{Claim,Effect}Child.mjs` are test-only subprocess programs.
- Existing PostgreSQL document/event/atomic integration tests: 11 passed. **Combined native + SQL: 14/14 pass**. Requires `PGTEST_URL` for local `/awfl_reconcile`, refuses external hosts. The workflows `reconcile-test postgres` command wires the native report automatically.
- Separate `reconcile-test durable` executes 23 native journal tests (22 passed, 1 skipped unrelated binary) with a compiled `helpers-ToolDefs` binary, in an in-memory Firestore-compatible adapter; this is **not** evidence that the PostgreSQL memory-store has a durable per-effect journal.

Remaining: full authenticated local Jobs Express service with isolated PG-backed document Storage, repeated ProjectManager turns, cross-session scheduling, and a real durable journal crash/restart test using persistent storage. No production flags, GKE RBAC, or database cutovers were changed.

### Combined gate result

`reconcile-test all --strict-background` with isolated `PGTEST_URL` and the compiled 26-workflow report returned exit 0. Cold Rust build is relatively expensive (~262 s); subsequent unchanged rebuild compiled/verified in 7.6 s. Native replay fixtures and all storage recovery tests passed. The workflows launcher rejects non-loopback PostgreSQL URLs and wrong database names before any SQL test invocation. Remaining work is running a real Jobs Express app against local Postgres and durable-journal crash/restart in a persistent backing store.

### Production Jobs scoped storage router verification

A fourth native/Postgres integration case mounts the **real** `createFirebaseDbRouter` with `workflowsUserInject` and `projectIdMiddleware` in a loopback-only Express app against isolated `PostgresStorage`. It verifies project-scoped create/read, 409 duplicate handling, and two simultaneous lock acquisitions with exactly one winner; no Firestore network calls. The consolidated PostgreSQL suite now passes **15/15** tests. This covers actual Jobs route behavior; the full `jobs.server.js` app and cloud-dependent LLM/context/callback routes remain a separate integration gate.
