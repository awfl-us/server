# Secret Manager resources for runtime configuration
# - Stores the GKE cluster CA certificate (base64) as a secret so it never
#   appears in the public .github/actions-variables.json.
# - Grants the Cloud Run runtime service account accessor permissions.

# NOTE: Secret Manager API enablement is defined in infra/apis.tf as
# google_project_service.secretmanager. No duplicate here.

# Secret holding the base64-encoded cluster CA certificate
# Note: google_container_cluster.awfl.master_auth[0].cluster_ca_certificate is a base64 string.
resource "google_secret_manager_secret" "k8s_ca_b64" {
  project   = var.project_id
  # Use an ID that matches the env var name used at runtime
  secret_id = "K8S_CA_CERT_B64"

  # Provider v7+: use auto {} instead of automatic = true
  replication {
    auto {}
  }

  depends_on = [google_project_service.secretmanager]
}

# Current version populated from the live cluster's CA cert (base64)
resource "google_secret_manager_secret_version" "k8s_ca_b64_latest" {
  secret      = google_secret_manager_secret.k8s_ca_b64.id
  secret_data = google_container_cluster.awfl.master_auth[0].cluster_ca_certificate

  depends_on = [
    google_secret_manager_secret.k8s_ca_b64,
    google_container_cluster.awfl,
  ]
}

# Optional: grant the GitHub deployer SA accessor for validation and smoke tests
# (Not strictly required for Cloud Run runtime access, but useful if your CI needs to read the secret.)
# resource "google_secret_manager_secret_iam_member" "k8s_ca_accessor_github" {
#   project   = var.project_id
#   secret_id = google_secret_manager_secret.k8s_ca_b64.id
#   role      = "roles/secretmanager.secretAccessor"
#   member    = "serviceAccount:${google_service_account.github_deployer.email}"
# }
