# Enable Google Workflows and Workflow Executions APIs
# Fixes: PERMISSION_DENIED for workflowexecutions.googleapis.com

resource "google_project_service" "workflows" {
  project            = var.project_id
  service            = "workflows.googleapis.com"
  disable_on_destroy = false
  depends_on = [
    google_project_service.cloudresourcemanager,
    google_project_service.serviceusage,
  ]
}

resource "google_project_service" "workflowexecutions" {
  project            = var.project_id
  service            = "workflowexecutions.googleapis.com"
  disable_on_destroy = false
  depends_on = [
    google_project_service.cloudresourcemanager,
    google_project_service.serviceusage,
  ]
}
