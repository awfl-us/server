variable "project_id" {
  description = "GCP project ID to create resources in"
  type        = string
}

# Optional: supply project-level roles to grant the service account
# Example:
# project_roles = [
#   "roles/viewer",
#   "roles/storage.objectViewer"
# ]
variable "project_roles" {
  description = "Project-level IAM roles to bind to the service account"
  type        = list(string)
  default     = []
}

# Name of the GCS bucket used by the consumer for workspace sync.
# When set, the local dev service account will be granted objectViewer on this bucket.
variable "gcs_bucket" {
  description = "GCS bucket name used for workspace sync"
  type        = string
  default     = ""
}

# Service account used by local dev server
resource "google_service_account" "dev_server" {
  account_id   = "local-dev-server"
  display_name = "Local Dev Server Service Account"
  depends_on   = [google_project_service.iam]
}

# Optional: grant project-level roles to the service account
resource "google_project_iam_member" "dev_server_bindings" {
  for_each = toset(var.project_roles)
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.dev_server.email}"
}

# ------------------------------
# Bucket-level IAM for local dev SA
# Reference the bucket resource directly to enforce creation ordering.
# ------------------------------

# Read access (list/get)
resource "google_storage_bucket_iam_member" "dev_server_object_viewer" {
  count  = local.shared_bucket_name != "" ? 1 : 0
  bucket = google_storage_bucket.shared.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.dev_server.email}"
  depends_on = [
    google_service_account.dev_server,
    google_storage_bucket.shared,
  ]
}

# Write access (create new objects under allowed prefixes)
resource "google_storage_bucket_iam_member" "dev_server_object_creator" {
  count  = local.shared_bucket_name != "" ? 1 : 0
  bucket = google_storage_bucket.shared.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.dev_server.email}"
  depends_on = [
    google_service_account.dev_server,
    google_storage_bucket.shared,
  ]
}

# Full object admin (create, overwrite, delete, update metadata)
resource "google_storage_bucket_iam_member" "dev_server_object_admin" {
  count  = local.shared_bucket_name != "" ? 1 : 0
  bucket = google_storage_bucket.shared.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.dev_server.email}"
  depends_on = [
    google_service_account.dev_server,
    google_storage_bucket.shared,
  ]
}

# ------------------------------
# Workflows IAM (locals only)
# Grant both Workflows Invoker and Workflows Viewer to local dev SA.
# ------------------------------
locals {
  workflows_members = toset([
    "serviceAccount:${google_service_account.dev_server.email}"
  ])
}

resource "google_project_iam_member" "workflows_invoker_group" {
  for_each = local.workflows_members
  project  = var.project_id
  role     = "roles/workflows.invoker"
  member   = each.value
  depends_on = [google_service_account.dev_server]
}

resource "google_project_iam_member" "workflows_viewer_group" {
  for_each = local.workflows_members
  project  = var.project_id
  role     = "roles/workflows.viewer"
  member   = each.value
  depends_on = [google_service_account.dev_server]
}

# ------------------------------
# Project-level Secret Manager access for Cloud Run runtime SA
# Grants the default Compute Engine service account secret accessor on the project.
# This satisfies Cloud Run deploy-time validation for --set-secrets.
# ------------------------------
resource "google_project_iam_member" "runtime_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${data.google_project.project.number}-compute@developer.gserviceaccount.com"
}

# Create a key for the service account (JSON credentials)
# NOTE: The private key is stored in Terraform state; keep state secure.
resource "google_service_account_key" "dev_server" {
  service_account_id = google_service_account.dev_server.name
  depends_on         = [google_service_account.dev_server, google_project_service.iamcredentials]
}

# Write the decoded JSON key to the repo root so docker-compose can mount it
resource "local_file" "service_account_key_json" {
  content  = base64decode(google_service_account_key.dev_server.private_key)
  filename = "${path.module}/../serviceAccountKey.json"
}

output "service_account_email" {
  description = "Email of the created service account"
  value       = google_service_account.dev_server.email
}

# Yes, we can output the JSON key from Terraform. Marked sensitive.
output "service_account_key_json" {
  description = "Service account key JSON (sensitive)"
  value       = base64decode(google_service_account_key.dev_server.private_key)
  sensitive   = true
}

# ==============================================================
# AWFL Producer/Consumer service accounts and minimal IAM
# ==============================================================

# Producer service account
resource "google_service_account" "producer" {
  account_id   = "awfl-producer"
  display_name = "AWFL Producer Service Account"
  depends_on   = [google_project_service.iam]
}

# Consumer service account
resource "google_service_account" "consumer" {
  account_id   = "awfl-consumer"
  display_name = "AWFL Consumer Service Account"
  depends_on   = [google_project_service.iam]
}

# Project-level logging for both SAs
resource "google_project_iam_member" "producer_logging" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.producer.email}"
}

resource "google_project_iam_member" "consumer_logging" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.consumer.email}"
}

# Allow producer SA to create tokens on itself (self-impersonation)
resource "google_service_account_iam_member" "producer_token_creator_self" {
  service_account_id = google_service_account.producer.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.producer.email}"
}

# Minimal GCS read on the shared/project bucket for producer only
resource "google_storage_bucket_iam_member" "producer_object_viewer" {
  count      = var.gcs_bucket != "" ? 1 : 0
  bucket     = var.gcs_bucket
  role       = "roles/storage.objectViewer"
  member     = "serviceAccount:${google_service_account.producer.email}"
  depends_on = [google_service_account.producer]
}

# Placeholder: grant Cloud Run run.invoker on the consumer service to the producer SA
# This is gated behind a flag and requires the service name/region to be specified.
resource "google_cloud_run_service_iam_member" "consumer_invoker_from_producer" {
  count    = var.enable_consumer_invoker_binding && var.consumer_service_name != "" && var.consumer_service_region != "" ? 1 : 0
  project  = var.project_id
  location = var.consumer_service_region
  service  = var.consumer_service_name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.producer.email}"
}

# Grant Pub/Sub editor to the SAs that actually create subscriptions:
# - local dev server SA
# - default Compute Engine SA (used by orchestration service)
resource "google_project_iam_member" "dev_server_pubsub_editor" {
  project = var.project_id
  role    = "roles/pubsub.editor"
  member  = "serviceAccount:${google_service_account.dev_server.email}"
}

resource "google_project_iam_member" "default_compute_sa_pubsub_editor" {
  project = var.project_id
  role    = "roles/pubsub.editor"
  member  = "serviceAccount:${data.google_project.project.number}-compute@developer.gserviceaccount.com"
}

# Outputs for SA emails
output "producer_service_account_email" {
  description = "Email of the AWFL Producer service account"
  value       = google_service_account.producer.email
}

output "consumer_service_account_email" {
  description = "Email of the AWFL Consumer service account"
  value       = google_service_account.consumer.email
}

# Variables controlling the optional Cloud Run invoker binding
variable "enable_consumer_invoker_binding" {
  description = "Enable binding roles/run.invoker on the consumer Cloud Run service to the producer SA"
  type        = bool
  default     = false
}

variable "consumer_service_name" {
  description = "Name of the Cloud Run Consumer service (for optional invoker binding)"
  type        = string
  default     = ""
}

variable "consumer_service_region" {
  description = "Region of the Cloud Run Consumer service (for optional invoker binding)"
  type        = string
  default     = ""
}
