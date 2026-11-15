# Managed Firestore latency: read-only verification (November 14, 2026 ET)

The AWFL GKE development consumer has a **user OAuth access token** injected
at the path referenced by `CLOUDSDK_AUTH_ACCESS_TOKEN_FILE`. It is configured
for `gcloud` using `auth/access_token_file`. Do **not** infer the active OAuth
principal from the `gcloud auth list` or `core.account` *label*: the token owner
was verified using Google's OAuth tokeninfo endpoint (no token was committed
or logged). The token was scoped for `cloud-platform`. Google Cloud IAM
identified the OAuth owner as `roles/owner` on project `awfl-us` and direct
Cloud Storage API reads of the Terraform state bucket were authorized.

## Actual service measurement

- Service: managed **Cloud Firestore** `(default)` in `nam5`.
- Client: Python `requests.Session` HTTPS REST API from AWFL's GKE consumer,
  authenticated using the injected user OAuth bearer token.
- Read target: one existing synthetic/native execution document,
  `nativeWorkflowExecutions/native_e5db8526091d493fb72f8ae36dc5e205`.
- Payload: 3,877 bytes in the Firestore API response.
- 60 requests, discard first 5; **55 warmed successful reads**.
- Observed latency: **p50 34.11 ms**, **p90 45.32 ms**, **p95 122.52 ms**,
  **p99 approximately 129.96 ms**, minimum 9.11 ms, maximum 131.21 ms.
- This is **read-only** and is not equivalent to the Node Firestore SDK or
  a guarded execution completion; no performance conclusion about new RTDB
  or Cloud SQL instances follows from these data.

## Infrastructure status

The benchmark stack's Terraform GCS backend was successfully initialized and
its provider configuration validated. With `GOOGLE_OAUTH_ACCESS_TOKEN` supplied
from the injected OAuth token file, `terraform plan` reported **9 to create,
0 to change, 0 to destroy** (without the optional benchmark user variable).
**Historical note:** This snapshot predates successful database provisioning.
Both test databases are now active; see [the completed managed three-backend
benchmark](storage-pilot-managed-three-backend-benchmark-2026-11-14.md).

The live Realtime Database Management and Cloud SQL Admin APIs were disabled
at the time of the investigation. Attempts to apply the infrastructure were
blocked by the execution environment's safety check; **neither managed
instance was provisioned** and there is no real managed three-backend
latency comparison. A read-only plan does not incur the proposed idle cost.

The Terraform configuration now optionally accepts `benchmark_user_email` to
permit IAM DB authentication from a Google user identity in addition to the
existing `awfl-consumer` service account, without committing a user email or
password. Provisioning and managed-service benchmarks remain the next step.

To avoid accidentally using ambient GKE service account credentials instead of
the injected OAuth user token with Terraform, configure the Google provider and
GCS backend with `GOOGLE_OAUTH_ACCESS_TOKEN` from the injected token file in
the *same local process*. Never print or commit the token or put it in Terraform
state or plan files.
