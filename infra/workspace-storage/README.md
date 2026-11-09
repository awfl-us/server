# AWFL project workspace storage

This dedicated Terraform root owns the **existing** `awfl-us-work-bucket` and
the token-broker IAM binding. It has its own GCS remote state at
`tfstate-awfl-web/infra/workspace-storage`, separate from the other stacks.

The bucket has no expiration rule for current objects. Versioning is enabled,
and Terraform prevents accidental bucket destruction. The Cloud Run API's
existing service account can mint prefix-scoped access tokens; the GKE
consumer does not have direct bucket-wide access.

On initial adoption: `terraform init` then
`terraform import google_storage_bucket.workspaces awfl-us-work-bucket`.
For subsequent updates: `terraform plan` followed by `terraform apply`.
Use an identity authorized for the GCS backend and bucket IAM changes.
