# GKE guardrails (independent Terraform state)

This narrowly scoped root manages **only** the Kubernetes ResourceQuota
and LimitRange in the existing `awfl` namespace of the existing `awfl-gke`
Autopilot cluster. It never creates or alters the cluster.

Remote Terraform state is isolated in the existing GCS bucket
`tfstate-awfl-web`, prefix `infra/gke-guardrails` and is distinct
from the website's `infra/envs/prod` prefix.

With a Google identity authorized for Kubernetes and GCS:
```bash
cd infra/gke-guardrails
terraform init
terraform plan -out=quota.tfplan
terraform apply quota.tfplan
terraform state list
```

Pod/CPU/memory limits are configured in `limits.tf`: 20 active Pods,
10 vCPU, 40Gi RAM, 20Gi ephemeral storage, and 25 Job objects. At the
default 0.5 vCPU/2Gi/1Gi request per environment, all 20 fit the quota. Terraform is
separate from the CI deployment workflow; changes to this directory
must be applied using the existing remote state.

Existing Pods are NOT evicted when you lower the quota; new Pods will be
rejected until consumption drops below the caps. Kubernetes quotas
cannot guarantee a limit in dollars or protect other namespaces/services.
