# Native workflow execution infrastructure. GCP IAM is the deployment and
# service-to-service authority; AWFL users never receive deploy or Jobs IAM.
#
# The Workflows Terraform root owns the dedicated native-artifact bucket and
# its release-publisher/runtime-reader IAM. Keep that bucket in the SAME
# tracked state as the existing Workflows deployment service account.
# This server Terraform root owns only Cloud Tasks and Jobs invocation IAM.

resource "google_project_service" "cloudtasks" {
  project            = var.project_id
  service            = "cloudtasks.googleapis.com"
  disable_on_destroy = false
  depends_on = [
    google_project_service.cloudresourcemanager,
    google_project_service.serviceusage,
  ]
}

resource "google_cloud_tasks_queue" "native_workflows" {
  name     = "native-executions"
  location = var.region
  project  = var.project_id

  rate_limits {
    max_dispatches_per_second = 5
    max_concurrent_dispatches = 10
  }

  retry_config {
    max_attempts       = 20
    max_retry_duration = "3600s"
    min_backoff        = "10s"
    max_backoff        = "300s"
    max_doublings      = 5
  }

  # Each delivery resumes a whole native workflow, never one pure DSL step.
  depends_on = [google_project_service.cloudtasks]
}

# The native task identity may ONLY invoke the existing Jobs Cloud Run
# service. The API runtime (default Compute SA) can enqueue authenticated
# tasks but end users cannot mint or directly invoke native executions.
resource "google_service_account" "native_task_invoker" {
  project      = var.project_id
  account_id   = "awfl-native-task-invoker"
  display_name = "AWFL native workflow Cloud Tasks invoker"
}

resource "google_cloud_tasks_queue_iam_member" "native_enqueue_runtime" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_tasks_queue.native_workflows.name
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${local.default_compute_sa}"
}

# Creating an OIDC-authenticated task requires iam.serviceAccounts.actAs on
# its task service account, not ownership of the target Cloud Run service.
resource "google_service_account_iam_member" "native_tasks_act_as" {
  service_account_id = google_service_account.native_task_invoker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${local.default_compute_sa}"
}

resource "google_cloud_run_service_iam_member" "native_tasks_jobs_invoker" {
  count      = var.cloud_run_services_exist ? 1 : 0
  project    = var.project_id
  location   = var.region
  service    = "jobs"
  role       = "roles/run.invoker"
  member     = "serviceAccount:${google_service_account.native_task_invoker.email}"
  depends_on = [google_project_service.run]
}

# The native effect dispatcher uses the Jobs runtime's own GCP identity to
# invoke the existing authenticated Jobs endpoints (the same trust boundary
# as Google Workflows). Do not grant this role to application end users.
resource "google_cloud_run_service_iam_member" "native_runtime_jobs_invoker" {
  count      = var.cloud_run_services_exist ? 1 : 0
  project    = var.project_id
  location   = var.region
  service    = "jobs"
  role       = "roles/run.invoker"
  member     = "serviceAccount:${local.default_compute_sa}"
  depends_on = [google_project_service.run]
}
