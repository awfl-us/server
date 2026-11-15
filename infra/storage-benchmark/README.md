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
