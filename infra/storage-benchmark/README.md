# Isolated AWFL storage pilot infrastructure

Terraform owns a dedicated Firebase Realtime Database instance, an isolated
Cloud SQL PostgreSQL 15 `db-f1-micro` zonal instance (10 GiB), IAM database login
for `awfl-consumer`, and the RTDB deny-all client rules. **Do not run against
production execution records**; SDK Admin / OAuth2 benchmark credentials bypass
RTDB client rules. No static DB passwords, public PostgreSQL authorized CIDRs,
or untracked Terraform changes. `terraform_data` runs a local provisioner to
publish RTDB rules because the provider has no RTDB rules resource.

State: `gs://tfstate-awfl-web/infra/storage-benchmark/default.tfstate`.
Provision with `terraform init`, `terraform plan`, `terraform apply` from this
directory with an account that can create SQL/Firebase instances and update IAM.
Resources are billable even at zero traffic (Cloud SQL approx. $10–15/mo).
To clean up, run `terraform destroy` for this stack after the investigation.

Use the Cloud SQL Auth Proxy v2 with `--auto-iam-authn`, started using the
`awfl-consumer` GKE identity, and `PGHOST=127.0.0.1`, `PGPORT=5432`, `PGDATABASE=awfl_bench`,
`PGUSER=awfl-consumer@awfl-us.iam` (the Terraform output is authoritative).
Set `RTDB_DATABASE_URL` using the Terraform output; never commit tokens.

## Injected OAuth identity for direct managed benchmarks

The AWFL cloud environment also injects a user OAuth bearer access token via
`CLOUDSDK_AUTH_ACCESS_TOKEN_FILE`. The active `gcloud` account label may be a
service account even when the actual OAuth token belongs to a Google user:
check the token principal (without logging or printing token contents) before
concluding that IAM blocks infrastructure operations. The Google Terraform
provider and GCS backend require `GOOGLE_OAUTH_ACCESS_TOKEN` to use this
injected user token instead of ambient application-default credentials.

Optionally set `TF_VAR_benchmark_user_email` to the **token's actual Google user
email address** when provisioning, to enable a Cloud SQL IAM database user;
this is not needed for the existing `awfl-consumer` IAM login. Configure the
Cloud SQL Auth Proxy for the same principal, and never commit credential values.

See `docs/storage-pilot-managed-firestore-baseline-2026-11-14.md` for a
read-only managed Firestore latency sample and the current provisioning status.

## Provisioned managed benchmark status (Nov 14 ET / Nov 15 UTC)

The isolated RTDB and Cloud SQL PostgreSQL 15 `db-f1-micro` resources have now
been provisioned via the injected user OAuth token, and the final Terraform
plan returned **No changes**. RTDB client security rules deny all end users;
Cloud SQL authenticates via IAM, without static database passwords. The
Cloud SQL instance continues to incur the benchmark's idle instance cost even
when no benchmarks are running. Terraform owns all created resources.

See the managed three-way benchmark report in
`../../docs/storage-pilot-managed-three-backend-benchmark-2026-11-14.md`.
