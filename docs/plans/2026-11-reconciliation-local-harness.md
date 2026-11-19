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
2. Add deterministic fake `READ_FILE` tool return with correct tool-call ID and callback, and exercise the **full** tool-call/continuation roundtrip; failure paths for missing callbacks, malformed tool outputs, and native recovery.
3. Stand up an isolated Postgres DB and local Jobs on localhost:5055 with test-only user/project and LLM responses; validate actual Postgres persistence/locking and retry using existing storage tests. Never widen GCP IAM to get local tests to pass.
4. After local checks, compare one isolated canary to production-shaped behavior; measure response, usage, context capture, cache and error telemetry. No Google Workflows.

## Isolation guarantees

Feature code only touches local `scripts/` runners and docs; no production route, model, storage or IAM behavior is modified. The new fixture does not make external requests and rejects unknown routes. The runner still requires explicit identity/project; native child identity and Jobs-origin checks remain active. Do not add fixture fallbacks to production worker code.
