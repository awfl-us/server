# Deployment and real acceptance-test access only. No permissions are granted
# to the execution KSA or the code-execution containers.
resource "google_project_iam_member" "deployer_mcp_datastore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.github_deployer.email}"
}

# Cluster connection/read metadata; actual mutations use namespace-scoped RBAC,
# bootstrapped once with cloud/execution/deployer-rbac.yaml by a cluster admin.
resource "google_project_iam_member" "deployer_mcp_cluster_viewer" {
  project = var.project_id
  role    = "roles/container.clusterViewer"
  member  = "serviceAccount:${google_service_account.github_deployer.email}"
}
