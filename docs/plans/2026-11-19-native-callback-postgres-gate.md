# Native callbacks: real Jobs HTTP + isolated PostgreSQL gate

> **RELEASE STATUS (2026-11-19): MERGED AND DEPLOYED.** The following
> entries document historical test gates. Full production evidence and
> remaining limitations are in
> `docs/plans/2026-11-19-wip-old-production-release.md`.
> **Active priority: PostgreSQL memory-mode execution for latency.** Legacy durable per-effect Firestore journaling is intentionally deferred. It is not a release gate for the current `wip-old` work.

2026-11-19, wip-old reconciliation, test-only.

## Confirmed

The native callback implementation already uses a deterministic ID for each
journaled callback.create and a transaction that accepts the first delivery,
acknowledges an identical duplicate, and rejects a conflicting duplicate.
This gate now exercises the **actual** authenticated Jobs Express routers,
not a custom callback HTTP responder:

```bash
PGTEST_URL=postgres://awfl@127.0.0.1:55439/awfl_reconcile \
  node --test test/storage/nativeCallbackRoutes.integration.test.mjs
```

Only loopback `/awfl_reconcile` (local development) and `/benchmark_ci`
(GitHub Actions' isolated database) are allowed. The test explicitly
initializes the existing document schema in that isolated database. It checks
that:

- callback registration returns the already-created native ID, without
  rewriting its document;
- 12 concurrent deliveries result in **one** PostgreSQL transaction commit,
  with identical retries returning `recorded:false` and no revision bump;
- differing repeat payloads return HTTP 409;
- incorrect authenticated project / owner are rejected;
- unknown native callback IDs return HTTP 404 without contacting Firestore;
- a waiter sees delivery via a separate PostgreSQL connection; a new
  callback-effects instance/new database pool can read completed delivery
  after an apparent process restart;
- an unrelated callback remains separate.

## Bug fixed

Under PostgreSQL, `workflows/callbacks/index.js` fell back to a Firestore
MCP lookup for **every** missing ID. Missing native `n<32hex>` IDs never
represent historical MCP callback records. The fallback now applies only
to non-native IDs; otherwise a missing native ID returns HTTP 404. This
also removes an unnecessary GCP permission dependency from native misses.

## Verified regressions

- Combined callback, typed HTTP and existing callback-effect tests:
  **13 passed, one real-binary optional test skipped**.
- Refined callback route + callback-effect tests: **7/7 passed**.
- Existing native PostgreSQL `reconcilePostgresNative.test.mjs`:
  **4/4 passed** with compiled Project Manager closure, including leased
  worker SIGKILL, epoch fencing, completed-workflow replay and stable
  effect keys after an HTTP-response crash. That suite tests **memory-mode
  execution**, not a durable per-effect journal.

## Remaining acceptance work

- PostgreSQL memory-mode recovery and stable effect idempotency across actual
  process crash; do not claim per-effect journaling. The legacy durable
  journal migration is deferred and not an acceptance gate.
- Session lock behavior with concurrent tool callbacks/LLM continuation,
  including slow/failing tools.
- Native EventHandler HTTP 422 propagation for rejected typed tool arguments.
- Provider canary and code merge/release after all applicable gates.
No production deploy and no live provider call occurred here.

## Session lock / memory-mode HTTP error checkpoint (2026-11-19)

- Real Jobs PostgreSQL lock routes: 12 simultaneous acquisitions yielded one
  winner; another session could acquire independently; stale owner releases
  did not unlock; expired owner takeover and lease TTL were checked.
  `test/storage/sessionLocksPostgres.integration.test.mjs` passes alongside
  the existing Jobs storage parity test (2/2).
- Lock fixes: report `released:false` for non-owner releases; validate TTL
  ranges; on expiry assign the new owner's requested TTL rather than reusing
  the expired owner's TTL.
- Confirmed HTTP 422 is classified by native HTTP handlers and persisted as
  a terminal error by a real compiled memory-mode Rust workflow backed by
  PostgreSQL. Restarted worker returns the saved failure without reissuing
  the HTTP request. Memory-mode and HTTP suites pass 10/10.

**Workflow-level contention bug reproduced and corrected (WF-02/WF-04):**
Two compiled native Project Manager roots using PostgreSQL memory-mode
execution and the actual Jobs session lock routes previously both returned
`completed`, although only one assistant response existed for two saved
user turns. The revised Scala `EventHandler` moves user/task persistence
inside the acquired-lock branch, raises a 409 for busy requests, and
propagates failure to the native execution status. The repeatable
`scripts/reconcileMemoryConcurrency.test.mjs` verifies the first root
completes, the second is explicitly `failed` with error code 409 without
saving an orphaned user message, and retrying the rejected turn after the
lock releases completes once. Final messages are
`user, assistant, user, assistant` and exactly two foreground model calls.
It uses the **actual compiled Rust Project Manager**, PostgreSQL native
memory roots and the real Jobs Express lock routes; it does not deploy
the workflow or invoke a live LLM. The rebuilt closure passed 26/26 native
binaries, and three existing strict-background scenarios and typed Ista
native integration passed after the fix.

**Still open:** delay a real tool callback while concurrent session turns
arrive and verify tool result sequencing, terminal status and billing.
The caller/UI must resubmit a rejected 409; automatic queuing is not
part of this change, and long-lived lock renewal is not yet verified.

**Scope of 422 check:** the compiled memory-mode fixture exercised a native
HTTP effect, not the entire EventHandler `/llm/chat` request. A legacy
replay harness remained in `waiting_effect` when its synthetic 422 was
thrown as a generic unconfirmed Error. Test actual Jobs-route validation
and native EventHandler terminal state together before closing that gate.

## Memory-mode follow-up gates completed (2026-11-19)

- `reconcileMemoryCallbackConcurrency.test.mjs` holds `callback.await` while
  a second native Project Manager root runs in the same session. The second
  root gets terminal 409 without saving an orphaned query. The original
  tool call, tool result and assistant continuation are correctly ordered;
  the rejected prompt then succeeds when explicitly retried.
- `reconcileMemoryTyped422.test.mjs` exercises the **actual Jobs LLM HTTP
  route** with a mock provider returning invalid typed `READ_FILE` arguments.
  Scala `Llm.chatWithTools` opts into `validate_tool_arguments`, Jobs returns
  422, and compiled Rust EventHandler saves `failed` with code 422 without
  dispatching the invalid tool. The one provider completion is accounted
  for, and the session lock is released. This closes the previous limited
  handler-only 422 check.
- `executionFailureResponse.test.js` verifies public `/workflows/execute`
  failure normalization: a native session-busy code 409 becomes HTTP 409,
  `retryable:true`, and a readable string, instead of HTTP 500 with an
  object-valued `error`. Existing web `PromptComposer` keeps its draft when
  the awaited submit request rejects, allowing the user to retry manually.

All **three** native concurrency/422 regressions and **two** public-error
tests passed together. Tool-aware workflow-utils snapshot was compiled
locally and all **26 native closure binaries** recompiled/verified. This is
PostgreSQL **memory mode**, not the deferred durable per-effect journal.

Still required before production: an authenticated real-browser submission
test and a canary/merge decision. Cross-device simultaneous submissions may
still require a user-visible manual retry after a 409; automatic queueing is
deliberately not claimed.
