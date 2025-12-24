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

    # CORS allowlist origins (full URL). Comma/space-separated supported; server auto-expands base/www for https root domains.
    CORS_ALLOW_ORIGIN = "https://${var.root_domain}, https://www.${var.root_domain}"
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
  ]
}
