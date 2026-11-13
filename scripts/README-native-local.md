# Fast native ProjectManager testing inside AWFL GKE

Use the existing Scala GKE environment. No Cloud Run build, deployment,
Cloud Task, or GCS publication is required to iterate compiler/runner changes.

This harness uses **real compiled Rust binaries**, the production native
worker/continuation, native parallel fork/join, local compiled subworkflows,
and a serialized in-memory Firestore test adapter. It can read **real GCS
workflow files** using the GKE environment's existing authenticated token.

**Jobs HTTP operations are replayed from an authorized prior execution**.
This is a fast development test, not a real Jobs/IAM end-to-end test. The
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
