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
