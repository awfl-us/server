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
  the task identity and the server runtime identity.

It does **not** manage the Jobs service itself, the user authentication
service, the native artifact bucket, or any other server infrastructure.
The artifact bucket and its publisher/runtime IAM are owned by the
`awfl-us/workflows` repository's tracked Terraform state.

The queue may deliver one task per native workflow execution. The authenticated
Workflows API persists the verified user/project scope; the Jobs service is
deployed with `--no-allow-unauthenticated`. Jobs middleware trusts the
forwarded user ID only after Cloud Run authorizes the invoking OIDC identity.

To inspect this state safely with your existing GCP identity:

```sh
terraform -chdir=infra/native-execution init
terraform -chdir=infra/native-execution validate
terraform -chdir=infra/native-execution plan
```

Use a normal plan before any future apply. Avoid `-target` unless recovering
from a known state issue. Never merge or apply another Terraform root that
claims these resources.

The presence of these resources does **not** turn on Rust execution.
The server's Cloud Run deployment defaults `AWFL_NATIVE_EXECUTION_ENABLED`
to `0`. Enabling requires an explicit GitHub Actions repository variable and
successful live protocol, retry/reconciliation, and Jobs authentication tests.
