# AWFL native Rust / ProjectManager development — local first

This is the default for coding agents working on native execution.
**Do not redeploy Cloud Run or enqueue Cloud Tasks for every compiler or
server fix.** Reuse the existing AWFL Scala-capable GKE dev environment
and run the whole Jobs Express server and compiled Rust binaries locally.
Use real-cloud integration only after local checks pass.

## Run the real Jobs service locally

From the server checkout (locate it; workspace paths vary):

    PORT=5057 AWFL_JOBS_BIND_HOST=127.0.0.1 \
      AWFL_NATIVE_LOCAL_AUTH=1 \
      AWFL_NATIVE_JOBS_URL=https://jobs-4wmfqir74q-uc.a.run.app \
      GCP_PROJECT=awfl-us GOOGLE_CLOUD_PROJECT=awfl-us \
      WORKFLOWS_BASE_URL=http://127.0.0.1:5057 \
      NODE_ENV=development \
      node --import /path/to/localNativeGcpAuth.mjs jobs.server.js

This launches the same `jobs.server.js` Express application used by the
Cloud Run `jobs` service; it is **not a mock**. The routes at
`/jobs/firebase/*`, `/jobs/llm/*`, `/jobs/events`, `/jobs/producer/*` and
`/jobs/callbacks/*` are the actual implementations.

Use an AWFL Cloud Terminal **interactive, persistent foreground execution**
to keep the process running; ordinary `nohup` background processes may be
cleaned up when the terminal command returns. Verify from a separate command:

    curl -fsS http://127.0.0.1:5057/health
    curl -fsS -H 'x-user-id: dev-user' -H 'x-project-id: dev-project' \
      http://127.0.0.1:5057/jobs/events/health

Both returned HTTP 200 in the live Scala GKE workspace on Nov 13, 2026.
Do not assume a restarted workspace still has the process. Always check
its health and avoid duplicate listeners.

**Security and fidelity:** Keep this upstream-trusting development Jobs
server accessible by loopback only. Never expose it publicly or apply
its identity-hint trust model to a production endpoint. Health passing
does NOT prove that Firestore/GCS/LLM downstream calls work. The GKE
consumer default credentials have previously lacked access to protected
Jobs and Firestore; use existing authorized development configuration
or emulators where needed, not an unreviewed broad IAM grant.

The authorized GKE development preloader must use the consumer's existing
refreshed user token and retrieve the Jobs encryption secret; the path above
is environment-specific. The `AWFL_NATIVE_JOBS_URL` setting **must** be
the trusted HTTPS origin embedded in the compiled callbacks, even though
the actual HTTP traffic is redirected to local port 5057. Without it,
`/callbacks` registers a *legacy* callback ID instead of recognizing the
already-created native record, and `callback.await` times out. Keep
`AWFL_JOBS_BIND_HOST=127.0.0.1` in local development.

## Compile and run native ProjectManager locally

The Scala DSL remains the source of truth. In the workflows checkout,
with a sibling compiler-rust checkout:

    python3 scripts/native-dev.py codebase-ProjectManager --recursive

Reuse compiled Rust binaries when only the Node server code changed.
Point the local native executor's Jobs HTTP effects to
`http://127.0.0.1:5057` when downstream services are configured.

The server also has a **recorded-response replay runner**:
`npm run native:local` and `npm run test:native:local`, described in
[scripts/README-native-local.md](../scripts/README-native-local.md).
It runs the real Rust binaries, fork/join and local child workflows with
an in-memory transactional store, but replays HTTP results recorded from
an authorized run. This replay **does not** perform fresh Jobs HTTP
requests; do not call it a live service test, invent missing fixtures,
or treat an unavailable fixture as an actual Jobs error.

## Detached Rust workflow continuation

`workflow.run` with `connector_params.skip_polling=true` creates a
separate, pinned native execution and returns its execution name without
waiting. ProjectManager uses this for its `toolCallsCompleted`
self-continuation. Do not reinterpret it as synchronous recursion.

For persistent **GKE** Jobs deployments, enable both
`AWFL_NATIVE_EXECUTION_ENABLED=1` and
`AWFL_NATIVE_DETACHED_GKE_ENABLED=1` to start recovery scanning
for pending child executions. The scheduler resumes children after restart
using existing Firestore leases, without an additional Cloud Task. Cloud
Run request-scoped instances are not suitable for background child work.
Infrastructure and IAM stay Terraform-managed.

For real local Jobs effects (rather than replayed fixtures):

    NODE_ENV=development node scripts/nativeLocalRun.mjs \
      --report /workspace/native-dev-projectmanager-output/build-report.json \
      --input /workspace/projectmanager-replay.input.json \
      --local-jobs-url http://127.0.0.1:5057/ \
      --live-storage --wait-detached --require-pm-loop

The Jobs service, GCS, and callback Firestore require existing authorized
development credentials. The test reports the detached child's current
state; `--wait-detached` drains independently launched native children,
including those recursively enqueued. `--require-pm-loop` fails unless
the root requested tools and exactly one detached ProjectManager child
finished with a nonempty final message and no further tool calls. The
`AWFL_NATIVE_LOCAL_ASYNC_SUMMARY` includes the original launch identities,
even though completed Firestore records clear the `asyncLaunch` index flag.
Background Summaries/ExtractTopics outcomes are reported separately and do
not constitute a successful or failed ProjectManager self-continuation.

**Nov 13, 2026 result:** A live local Jobs/GCS/Firestore/LLM/CLI run passed:
the first ProjectManager requested LIST_DIRECTORY, ToolDispatcher saved its
result, a detached ProjectManager execution resumed and replied using that
result, and the second turn requested no more tools. Strict verification
passed on a repeated local run. The native scheduler's restart scanner also
passed a simulated restart with the real native execution-store adapter.
This does **not** prove that a persistent GKE Jobs worker survives an actual
pod restart: the local execution store is in memory. Background summary and
context children still exhibited intermittent 409 lock conflicts, native log
validation errors, and an unrelated subtraction-type failure.

## Default debug/test sequence

1. Inspect GKE environment, server checkout, existing server process and
   compiled artifacts. Start local Jobs in persistent interactive mode.
2. Run a small targeted test, then run native Rust execution with the local
   Jobs server (or recorded-response runner if fresh downstream auth is
   unavailable). Track the *first* failing effect.
3. Fix and rerun locally; avoid unnecessary full builds, publication,
   server redeployment or broad audits.
4. Once local tests pass, run full native regression tests.
5. Only at integration milestones, use an **isolated, zero-production-
   traffic Cloud Run canary** and the normal authenticated API/Cloud Tasks
   path to verify IAM, Firestore, GCS and real remote effects.

Distinguish a real local Jobs route, a mocked effect, a replayed HTTP
response and a real authenticated cloud call in reports. They are not
interchangeable. Keep production native routing disabled until verified.

**All permanent infrastructure/IAM changes must be in Terraform.**
