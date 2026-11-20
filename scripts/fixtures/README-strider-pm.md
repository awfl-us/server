# Local Strider → Project Manager summary test

Use the compiled Rust **memory-mode** workflow closure and an **isolated**
PostgreSQL `awfl_reconcile` database. The default run needs no cloud
credentials, OpenAI key, external HTTP calls, or production deployment.

1. Start the local database using
   `docker compose -f scripts/compose.reconcile-postgres.yml up -d` from
   the **server** repository, or use an existing local PostgreSQL test database.
2. Compile the 27-workflow Project Manager closure from the **workflows**
   repository using its pinned `workflow-utils` source revision:
   `python3 scripts/native-dev.py codebase-ProjectManager --recursive
   --compiler /path/to/compiler-rust --output /path/to/local-artifacts`.
3. From the workflows checkout, run:

```bash
export PGTEST_URL='postgres://awfl:reconcile-test-only@127.0.0.1:55439/awfl_reconcile'
./scripts/reconcile-test strider-pm \
  --server /path/to/server \
  --strider-report /path/to/local-artifacts/build-report.json
```

The test seeds messages from `strider-summary-conversation.json`,
executes `Summaries-Convo` → `codebase-ProjectManager` →
`helpers-Convo`, validates the typed Jobs LLM request, reads the summary
from real Jobs PostgreSQL document storage, then repeats the same segment
to verify deduplication and lock release.

To test a different conversation, set `AWFL_STRIDER_CONVERSATION_FILE`
to an absolute path containing a JSON array of 1–24 objects with
`{"role":"user"|"assistant","content":"..."}`. The default adapter derives
a deterministic summary from the supplied user turns, allowing assertions
without a live model. It does **not** evaluate summary quality.

For an explicitly billed **live OpenAI** test, also set
`AWFL_STRIDER_PROVIDER=live`,
`AWFL_STRIDER_OPENAI_API_KEY` (or `OPENAI_API_KEY`), and optionally
`AWFL_STRIDER_MODEL=gpt-4.1-mini`. Do not commit credentials.
The real Jobs provider adapter is used and validation checks the returned
typed summary. Real provider runs are opt-in and may incur charges.

This intentionally isolates document storage and the LLM route; auxiliary
agent discovery, callback delivery, context lookup, and GCS script download
still use deterministic local fixtures. No production resources are accessed.

## Concurrent and failure-path gates

The same `strider-pm` command now runs **four** scenarios in isolated,
randomly scoped PostgreSQL collections (live mode only runs the sequential
scenario to avoid unintended multiple billable requests):

- `sequential`: create one typed summary, then repeat the same segment without
  another model call or summary write; both lock releases succeed.
- `contended`: hold the first Jobs LLM response while a second compiled native
  Strider runs against the same segment using a **separate PostgreSQL
  connection pool and native execution-store instance**. Exactly one lock
  acquire succeeds, the other gets an authentic `409`, and the winner creates
  exactly one summary. Retrying later cannot duplicate the summary.
- `provider-failure`: force the real Jobs LLM route to return a provider error;
  the native workflow fails without writing, releases its owner-scoped lock,
  and a fresh native run successfully persists one summary.
- `callback-failure`: fail `callback.await` **after** the first typed model
  response, not at startup; verify no write on failure, exact owner-scoped
  release, and a successful retry. Callback URLs are checked for matching
  local `callback.create` effects.

Every scenario runs the real Jobs PostgreSQL `/firebase` and `/llm/chat`
routes with **compiled native Rust**, verifies the lock collection has no
remaining documents, and uses the production authenticated native `log.write`
handler. A separate native Strider fixture covers previously stored 6 KB
topic records as well as 6 KB summaries. The contended scenario passed five
consecutive independent runs during the November 20 checkpoint.

**Boundary:** both independent native workers are in the same test process,
not two separately deployed GKE pods. Callback *delivery* and auxiliary
agent/context routing remain deterministic fixtures, so these tests cannot
prove production callback garbage collection or exactly-once external effects
after an actual process crash. Do not treat a locally created callback URL
as evidence a real callback record was persisted or cleaned up.
