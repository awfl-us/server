# AWFL GKE cost safeguards

## Idle timeout
POST /jobs/producer/start accepts idleTimeoutSeconds (alias idle_timeout_seconds),
60–86400 seconds, default 3600 (one hour). MCP workspace_create accepts
idle_timeout_seconds on new consumer startup. It is ignored when attaching to
an existing shared project consumer. Active or queued calls and running
subprocesses postpone shutdown; SSE heartbeats and lease renewals do not.

## Kubernetes admission caps
Terraform in infra/gke_limits.tf defines limits for the pre-existing awfl
namespace: 2 non-terminal Pods, up to 4 requested vCPU, 8Gi requested RAM,
4Gi requested ephemeral storage, and 8 Job objects. No container may use
more than 2 CPU/4Gi memory/2Gi ephemeral storage. Finished Jobs are cleaned
up after 300 seconds, reducing accumulation.

Run Terraform with existing state, cluster credentials and the awfl namespace
already present. Merging Terraform files does NOT apply these limits automatically.
The existing CI deployment workflow deploys server images only.

## Billing guardrails
Cloud Billing alerts are NOT spending caps. As of November 2026,
spend-cap budgets do not support GKE. An optional $50 project-wide monthly
alert is defined in infra/budget_alerts.tf and can be enabled with private
billing_account_id once billing permissions are available.

Namespace quotas are not project-wide financial guarantees. An attacker with
cluster-admin rights could use a different namespace or other GCP services.
Limit deployer IAM privileges, monitor Cloud Billing and consider project-level
service quotas separately.
