# Native Rust execution infrastructure

This is a **separate Terraform root**, independent from `server/infra`.
The main server Terraform root does not have its state available in this
workspace. Do not initialize/apply it against a fresh local state: that would
try to recreate existing GCP resources.

This module has its own GCS remote state:

`gs://tfstate-awfl-web/infra/native-execution/default.tfstate`

It manages only:

- the Cloud Tasks API and `native-executions` queue;
- the `awfl-native-task-invoker` service account;
- a queue-scoped enqueuer grant and the runtime's ability to act as that
  service account for OIDC tokens;
- `roles/run.invoker` on the existing **private** Jobs Cloud Run service for
  the task identity and the server runtime identity;
- one `native-jobs` GKE Deployment and service account in the existing
  `awfl` namespace, with Workload Identity for the established runtime SA;
- scoped CI access: project-level GKE cluster discovery plus Kubernetes RBAC
  to read/patch/watch **only** the `native-jobs` Deployment in `awfl`.

It does **not** manage the Jobs service itself, the user authentication
service, the native artifact bucket, or any other server infrastructure.
The artifact bucket and its publisher/runtime IAM are owned by the
`awfl-us/workflows` repository's tracked Terraform state.

The queue may deliver one task per native workflow execution. The authenticated
Workflows API persists the verified user/project scope; the Jobs service is
deployed with `--no-allow-unauthenticated`. Jobs middleware trusts the
forwarded user ID only after Cloud Run authorizes the invoking OIDC identity.

## Manual Terraform apply (NOT part of application CI)

Use an authorized GCP identity that can access the **existing** remote state
`gs://tfstate-awfl-web/infra/native-execution/default.tfstate`, administer
native-execution IAM, and manage the existing `awfl` GKE namespace. Use the
immutable server SHA-tagged image from the server CI build:

```sh
terraform -chdir=infra/native-execution init
terraform -chdir=infra/native-execution validate
terraform -chdir=infra/native-execution plan \
  -var='native_jobs_image=us-central1-docker.pkg.dev/awfl-us/app/api:<40-character-commit-sha>' \
  -out=native-jobs.tfplan
terraform -chdir=infra/native-execution apply native-jobs.tfplan
```

For workspaces using a short-lived OAuth credential instead of ADC, supply
`GOOGLE_BACKEND_ACCESS_TOKEN` (remote state) and
`GOOGLE_OAUTH_ACCESS_TOKEN` (Google/Kubernetes providers) in the *manual*
shell. Never store access tokens, keys, or Terraform state in Git.

The server GitHub Actions deployer intentionally has **no** access to Terraform
state. Do not put Terraform init/plan/apply in `deploy-cloud-run.yml`.
Application CI builds the same server image for Cloud Run API/Jobs and, when
`AWFL_NATIVE_EXECUTION_ENABLED=1`, updates the existing GKE worker using:

```sh
gcloud container clusters get-credentials awfl-gke --region us-central1 --project awfl-us
kubectl -n awfl set image deployment/native-jobs jobs=<immutable-server-image>
kubectl -n awfl rollout status deployment/native-jobs --timeout=300s
```

CI relies on the narrow Kubernetes Role/RoleBinding managed by this root.
Terraform deliberately ignores drift in the container image: future manual
applies must not downgrade a successful CI image rollout. New/initial
Deployments get the explicitly provided bootstrap image.

Use a normal plan before any future apply. Avoid `-target` unless recovering
from a known state issue. Never apply another Terraform root that claims these
resources.

The presence of these resources does **not** turn on Rust execution.
The server's Cloud Run deployment defaults `AWFL_NATIVE_EXECUTION_ENABLED`
to `0`. Enabling requires an explicit GitHub Actions repository variable and
successful live protocol, retry/reconciliation, and Jobs authentication tests.
