# Dedicated state for native Rust execution infrastructure. The main server
# Terraform root has no checked-in/known state; do NOT apply it with an empty
# state. Native execution infrastructure is isolated from that root.
terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 7.10.0, < 8.0.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = ">= 2.30.0, < 3.0.0"
    }
  }
  backend "gcs" {
    bucket = "tfstate-awfl-web"
    prefix = "infra/native-execution"
  }
}

variable "project_id" {
  type    = string
  default = "awfl-us"
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "jobs_service" {
  type    = string
  default = "jobs"
}

provider "google" {
  project = var.project_id
  region  = var.region
}

data "google_project" "current" {
  project_id = var.project_id
}

locals {
  runtime_sa = "${data.google_project.current.number}-compute@developer.gserviceaccount.com"
}

resource "google_project_service" "cloudtasks" {
  project            = var.project_id
  service            = "cloudtasks.googleapis.com"
  disable_on_destroy = false
}

resource "google_cloud_tasks_queue" "native" {
  name     = "native-executions"
  project  = var.project_id
  location = var.region

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

  depends_on = [google_project_service.cloudtasks]
}

resource "google_service_account" "task_invoker" {
  project      = var.project_id
  account_id   = "awfl-native-task-invoker"
  display_name = "AWFL native workflow Cloud Tasks invoker"
}

# Users of the existing authenticated API do not get Cloud Tasks IAM.
# Only its runtime identity may enqueue and act as the Cloud Tasks caller.
resource "google_cloud_tasks_queue_iam_member" "runtime_enqueue" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_tasks_queue.native.name
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${local.runtime_sa}"
}

resource "google_service_account_iam_member" "runtime_act_as" {
  service_account_id = google_service_account.task_invoker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${local.runtime_sa}"
}

# Cloud Run enforces the OIDC service identity before Jobs trusts the
# forwarded workflow user ID. No additional end-user auth is introduced.
resource "google_cloud_run_service_iam_member" "task_jobs_invoker" {
  project  = var.project_id
  location = var.region
  service  = var.jobs_service
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.task_invoker.email}"
}

# The native effect adapter invokes Jobs from the existing server runtime.
resource "google_cloud_run_service_iam_member" "runtime_jobs_invoker" {
  project  = var.project_id
  location = var.region
  service  = var.jobs_service
  role     = "roles/run.invoker"
  member   = "serviceAccount:${local.runtime_sa}"
}

output "native_queue" {
  value = google_cloud_tasks_queue.native.name
}

output "native_task_service_account" {
  value = google_service_account.task_invoker.email
}
