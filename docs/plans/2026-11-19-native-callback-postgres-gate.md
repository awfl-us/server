# Native callbacks: real Jobs HTTP + isolated PostgreSQL gate

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

Only a loopback `/awfl_reconcile` database is allowed. The test explicitly
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

- Native durable effect-journal persistence across actual process crash
  (different from memory-mode restart), with no repeated externally
  committed side effects.
- Session lock behavior with concurrent tool callbacks/LLM continuation,
  including slow/failing tools.
- Native EventHandler HTTP 422 propagation for rejected typed tool arguments.
- Provider canary and code merge/release after all applicable gates.
No production deploy and no live provider call occurred here.
