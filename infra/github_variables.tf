# Generate a JSON file with GitHub Actions repo variables to be set on merge
# The workflow in .github/workflows/set-actions-variables.yml will read this file
# and set/update repository-level Actions Variables via the GitHub CLI using GITHUB_TOKEN.

locals {
  # Default compute runtime service account (used by Cloud Run by default)
  default_compute_sa = "${data.google_project.project.number}-compute@developer.gserviceaccount.com"
}

# Optionally lookup Cloud Run service URLs only after services exist
# This is gated so that terraform apply works before the first deploy
data "google_cloud_run_service" "api" {
  count    = var.cloud_run_services_exist ? 1 : 0
  name     = "api"
  location = var.region
  project  = var.project_id
}

data "google_cloud_run_service" "jobs" {
  count    = var.cloud_run_services_exist ? 1 : 0
  name     = "jobs"
  location = var.region
  project  = var.project_id
}

# Derive effective proxy settings for clients (Cloud Run server, CI, etc.)
locals {
  k8s_api_endpoint   = google_container_cluster.awfl.endpoint
  # Build NO_PROXY with comma-only (no spaces) and trim outer whitespace
  no_proxy_effective = trimspace(join(",", compact([
    var.no_proxy,
    local.k8s_api_endpoint,
  ])))
}

resource "local_file" "actions_variables" {
  filename = "${path.module}/../.github/actions-variables.json"
  content  = jsonencode({
    GCP_WIF_PROVIDER       = google_iam_workload_identity_pool_provider.github.name
    GCP_DEPLOY_SA          = google_service_account.github_deployer.email
    GCP_PROJECT_ID         = var.project_id
    GCP_REGION             = var.region
    CLOUD_RUN_RUNTIME_SA   = local.default_compute_sa
    CLOUD_RUN_API_SERVICE  = "api"
    CLOUD_RUN_JOBS_SERVICE = "jobs"

    # Shared work bucket
    GCS_BUCKET = google_storage_bucket.shared.name

    # Service account emails for Producer and Consumer Jobs
    # deploy-cloud-run.yml expects *_JOB_SA_EMAIL (and falls back to CLOUD_RUN_RUNTIME_SA)
    PRODUCER_JOB_SA_EMAIL = google_service_account.producer.email
    CONSUMER_JOB_SA_EMAIL = google_service_account.consumer.email

    # Shared Pub/Sub topic used for req/resp channels
    PUBSUB_TOPIC = google_pubsub_topic.shared.name

    # Stable Cloud Run Job names (templates) for the orchestrator to run.
    # These are created/replaced by CI (deploy-cloud-run.yml) using cloud/*/job.yaml.
    PRODUCER_CLOUD_RUN_JOB_NAME = "awfl-producer"
    CONSUMER_CLOUD_RUN_JOB_NAME = "awfl-consumer"

    # Use Cloud Run Jobs service URL when available; otherwise provide a safe placeholder
    WORKFLOWS_BASE_URL = var.cloud_run_services_exist ? data.google_cloud_run_service.jobs[0].status[0].url : "https://jobs.${var.root_domain}"

    # Public API origin (DNS)
    API_ORIGIN = "https://api.${var.root_domain}"

    # CORS allowlist origins (full URL). Comma/space-separated supported; server auto-expands base/www for https root domains.
    CORS_ALLOW_ORIGIN = "https://${var.root_domain}, https://www.${var.root_domain}"

    # Kubernetes/GKE runtime config surfaced to GitHub vars
    GKE_CLUSTER_NAME     = google_container_cluster.awfl.name
    GKE_CLUSTER_LOCATION = google_container_cluster.awfl.location
    K8S_NAMESPACE        = var.k8s_namespace
    PRODUCER_KSA_NAME    = var.producer_ksa_name
    CONSUMER_KSA_NAME    = var.consumer_ksa_name

    # Kubernetes API endpoint (host/IP). Server URL is the HTTPS form commonly found in kubeconfigs.
    K8S_API_ENDPOINT = local.k8s_api_endpoint
    K8S_API_SERVER   = "https://${local.k8s_api_endpoint}"

    # Network proxy envs for server/clients: NO_PROXY automatically includes the cluster endpoint
    NO_PROXY   = local.no_proxy_effective
    HTTP_PROXY = var.http_proxy
    HTTPS_PROXY= var.https_proxy

    # Optional runtime knobs
    AWFL_LOCK_NO_REFRESH = var.awfl_lock_no_refresh
  })
  depends_on = [
    google_iam_workload_identity_pool_provider.github,
    google_service_account.github_deployer,
    # Ensure SAs exist before rendering their emails
    google_service_account.producer,
    google_service_account.consumer,
    # Ensure topic exists before referencing it
    google_pubsub_topic.shared,
    # Ensure bucket exists before referencing it
    google_storage_bucket.shared,
    # Include cluster so cluster/namespace/ksa vars are available
    google_container_cluster.awfl,
  ]
}

# -----------------
# Optional variables to surface into Actions Variables JSON
# -----------------
variable "no_proxy" {
  description = "Comma-separated NO_PROXY domains/hosts to exclude from proxies"
  type        = string
  default     = ""
}

variable "http_proxy" {
  description = "HTTP proxy URL for egress (optional)"
  type        = string
  default     = ""
}

variable "https_proxy" {
  description = "HTTPS proxy URL for egress (optional)"
  type        = string
  default     = ""
}

variable "awfl_lock_no_refresh" {
  description = "If set to a non-empty value, instructs the consumer to not auto-refresh external project locks"
  type        = string
  default     = ""
}
