# Opt-in timing for a native Jobs execution

Set `AWFL_NATIVE_PROFILE_ENABLED=1` **only** on an isolated Jobs revision
with `AWFL_NATIVE_EXECUTION_ENABLED=1`. A successful or failed Jobs request
then writes one structured `awfl_native_job_timing` Cloud Logging event,
containing its execution ID, outcome, total request duration and aggregated
phase timings. The response body and execution behavior are unchanged.

Phases include `gcs.materialize`, `firestore.get`, `firestore.claim`,
`firestore.prepareEffect`, `firestore.renew`, `firestore.recordEffect`,
`firestore.complete`, `runner.transition`, `rust.verify_stage_spawn`,
`rust.spawn_io`, `dispatcher.total`, `effect.http.get`, `oidc.client`, and
`oidc.http_request`. Each phase records count and inclusive `totalMs`.
**Do not add the times together:** spans are nested (for example
`dispatcher.total` includes `effect.http.get`, and `runner.transition`
includes `rust.spawn_io`).

Only fixed operation names, duration, outcome, and the native execution ID
are logged. Workflow inputs, URLs, request/response bodies, user/project
IDs and credentials are intentionally excluded. The flag defaults to off.
Restore it to off and remove temporary Cloud Run tags after benchmarking.
