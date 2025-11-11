# Workload Identity Federation for GitHub Actions OIDC and deploy service account

# NOTE: project_id, github_repository, and region variables are defined in other infra/*.tf files.

# Resolve project details (number is needed for some bindings)
data "google_project" "project" {
  project_id = var.project_id
  # Ensure required APIs are enabled before reading project metadata
  depends_on = [
    google_project_service.cloudresourcemanager,
    google_project_service.serviceusage,
    google_project_service.iam,
    google_project_service.iamcredentials,
  ]
}

# ------------------------------
# Workload Identity Pool and Provider for GitHub Actions OIDC
# ------------------------------
resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "github-oidc"
  display_name              = "GitHub OIDC Pool"
  description               = "Trust GitHub Actions OIDC tokens for this project"

  depends_on = [
    google_project_service.iam,
  ]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub"
  description                        = "OIDC provider for GitHub Actions"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
  # Limit which repositories can use this provider
  attribute_condition = "assertion.repository == '${var.github_repository}'"

  depends_on = [
    google_project_service.iam,
  ]
}

# ------------------------------
# Service account that GitHub Actions will impersonate for deploys
# ------------------------------
resource "google_service_account" "github_deployer" {
  project      = var.project_id
  account_id   = "github-deployer"
  display_name = "GitHub Actions Deployer"

  depends_on = [
    google_project_service.iam,
  ]
}

# Allow identities from the GitHub OIDC provider (this repository) to impersonate the SA
resource "google_service_account_iam_member" "deployer_wif" {
  service_account_id = google_service_account.github_deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/projects/${data.google_project.project.number}/locations/global/workloadIdentityPools/${google_iam_workload_identity_pool.github.workload_identity_pool_id}/attribute.repository/${var.github_repository}"

  depends_on = [
    google_project_service.iam,
  ]
}

# Project-level roles to deploy Cloud Run and use Cloud Build from source
resource "google_project_iam_member" "deployer_run_admin" {
  project = var.project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${google_service_account.github_deployer.email}"

  depends_on = [
    google_project_service.iam,
  ]
}

resource "google_project_iam_member" "deployer_cloudbuild_editor" {
  project = var.project_id
  role    = "roles/cloudbuild.builds.editor"
  member  = "serviceAccount:${google_service_account.github_deployer.email}"

  depends_on = [
    google_project_service.iam,
  ]
}

# Allow the deployer to set the runtime service account on Cloud Run (default compute SA)
resource "google_service_account_iam_member" "deployer_on_default_compute_sa" {
  service_account_id = "projects/${var.project_id}/serviceAccounts/${data.google_project.project.number}-compute@developer.gserviceaccount.com"
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.github_deployer.email}"

  depends_on = [
    google_project_service.iam,
  ]
}

# Grant permission to create/manage Firestore composite indexes
resource "google_project_iam_member" "deployer_datastore_index_admin" {
  project = var.project_id
  role    = "roles/datastore.indexAdmin"
  member  = "serviceAccount:${google_service_account.github_deployer.email}"

  depends_on = [
    google_project_service.iam,
  ]
}

# Helpful outputs
output "github_deployer_service_account_email" {
  description = "Service account email used by GitHub Actions for deployments"
  value       = google_service_account.github_deployer.email
}

output "workload_identity_provider_name" {
  description = "Full resource name of the WIF provider to use in github-gcloud auth"
  value       = google_iam_workload_identity_pool_provider.github.name
}
