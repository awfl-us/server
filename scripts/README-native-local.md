# Fast native ProjectManager testing inside AWFL GKE

Use the existing Scala GKE environment. No Cloud Run build, deployment,
Cloud Task, or GCS publication is required to iterate compiler/runner changes.

This harness uses **real compiled Rust binaries**, the production native
worker/continuation, native parallel fork/join, local compiled subworkflows,
and a serialized in-memory Firestore test adapter. It can read **real GCS
workflow files** using the GKE environment's existing authenticated token.

By default, **Jobs HTTP operations are replayed from an authorized prior
execution**. Pass `--local-jobs-url http://127.0.0.1:5055/` instead of
`--fixtures` for fresh HTTP against the **real local Jobs Express service**.
The URL must be loopback-only and only calls to the known Jobs origin are
redirected. Run Jobs in a separate persistent GKE terminal with authorized
development credentials. The live mode uses the actual
`callback.create`/`callback.await` handlers and never fabricates results.
It is not a production IAM end-to-end test.

For `workflow.run` with `skip_polling: true`, the parent completes
independently of the detached child. The local result's `lanes` shows
both recorded native executions and their current states. The in-memory
adapter is intentionally ephemeral: for **restart recovery**, use the
persistent GKE Jobs service and real Firestore.

This is a fast development test, not a production IAM end-to-end test. The
GKE consumer service account cannot invoke production Jobs or read
production Firestore/GCS via ADC; the environment's user token can read
the necessary records for fixtures. This tool does not grant extra IAM,
impersonate Jobs, or create a new service.

First build the native workflow closure in the workflows repository:

    python3 scripts/native-dev.py codebase-ProjectManager --recursive

Export input and recorded HTTP results from an authorized live native test:

    python3 scripts/exportNativeLocalFixtures.py --execution native_<id> \
      --out-prefix /workspace/projectmanager-replay

Then, in the server checkout:

    node scripts/nativeLocalRun.mjs \
      --report /workspace/compiler-rust/target/native-dev-generated/codebase-ProjectManager/build-report.json \
      --input /workspace/projectmanager-replay.input.json \
      --fixtures /workspace/projectmanager-replay.http.json \
      --live-storage

Override --report with the actual build-report path. An unset GCP_PROJECT is
read from CLOUDSDK_CORE_PROJECT in this GKE-only CLI.

For rapid repeated runs, export paths once in the GKE shell and then use
one short command without arguments:

    export AWFL_NATIVE_LOCAL_BUILD_REPORT=/workspace/native-dev-projectmanager-output/build-report.json
    export AWFL_NATIVE_LOCAL_INPUT=/workspace/projectmanager-replay.input.json
    export AWFL_NATIVE_LOCAL_FIXTURES=/workspace/projectmanager-replay.http.json
    npm run native:local -- --live-storage

The local run reports elapsed milliseconds, actual native fork count,
recorded Jobs replay calls, and **missing HTTP effects**. Record missing
effects through a live authenticated canary and rerun locally. Never invent
fixtures and do not interpret an expected missing-fixture failure as a
production service failure.

For the full real HTTP/IAM path, verify only at integration milestones using
the normal authenticated Workflows API -> Cloud Tasks -> Jobs revision.
The current native production traffic flag stays disabled. No IAM or
Terraform changes are needed for this replay workflow.

The exported JSON files contain live user/project data. They are written
with mode 0600 and must stay outside version-controlled source directories.

Testing:

    npm run test:native:local

Use AWFL_NATIVE_LOCAL_BUILD_REPORT to additionally validate all generated
binary hashes in the runtime smoke test.

## Reconciliation tests (optional test-only fixture API)

The new `scripts/reconcileScenario.mjs` is invoked from `workflows/scripts/reconcile-test`. It extends the existing native local runner with *optional*, explicit `respondHttp`, `storageHandler`, `callbackFixtureHandlers`, and `drainDetached` parameters. These do **not** alter the production native worker or Jobs HTTP endpoints; they run only when the developer explicitly passes a fixture. A deterministic in-memory Jobs/LLM/GCS/callback setup runs the real compiled ProjectManager native ELF and verifies root message roles. The route responder fails on unknown requests, preserving the existing Jobs-origin/identity guards.

For example, after building the workflows native closure, execute:

```bash
node scripts/reconcileScenario.mjs --report /path/to/build-report.json --scenario basic
node scripts/reconcileScenario.mjs --report /path/to/build-report.json --scenario no-query
node scripts/reconcileScenario.mjs --report /path/to/build-report.json --scenario basic --strict-background
```

The strict-background run is **expected to fail currently** on simulated topic/summarization detached native children; it is a non-green integration gate. The normal basic and no-query foreground tests pass; they should not be conflated with success of the complete background agent lifecycle. None of the fixture modes makes an OpenAI request or connects to production PostgreSQL. See the workflows testing guide for fidelity levels and outstanding work.
