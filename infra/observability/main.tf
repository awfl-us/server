# Dedicated observability state. The legacy server/infra root has no trusted
# state and must not be applied with an empty state. Follow native-execution.
terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 7.10.0, < 8.0.0"
    }
  }
  backend "gcs" {
    bucket = "tfstate-awfl-web"
    prefix = "infra/observability"
  }
}

variable "project_id" {
  type    = string
  default = "awfl-us"
}

provider "google" {
  project = var.project_id
}

data "google_project" "current" {
  project_id = var.project_id
}

resource "google_project_service" "telemetry" {
  project            = var.project_id
  service            = "telemetry.googleapis.com"
  disable_on_destroy = false
}

# Cloud Run API, Jobs, and GKE native-jobs Workload Identity all use this
# existing default compute SA. Scope the grant only to trace ingestion.
resource "google_project_iam_member" "runtime_trace_writer" {
  project = var.project_id
  role    = "roles/telemetry.tracesWriter"
  member  = format("serviceAccount:%s-compute@developer.gserviceaccount.com", data.google_project.current.number)
  depends_on = [google_project_service.telemetry]
}

output "trace_writer" {
  value = google_project_iam_member.runtime_trace_writer.member
}
