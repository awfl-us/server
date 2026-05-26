# Minimal GKE Autopilot cluster and Workload Identity wiring
# Notes:
# - Reuses existing service accounts from infra/iam.tf:
#     - google_service_account.producer
#     - google_service_account.consumer
# - Does NOT create any Kubernetes resources (no kubernetes provider). KSAs/namespaces
#   will be created later by app manifests or scripts. Here we only create the GKE
#   cluster and bind WI impersonation from KSAs to GSAs.

# Enable GKE API
resource "google_project_service" "container" {
  project            = var.project_id
  service            = "container.googleapis.com"
  disable_on_destroy = false
  depends_on = [
    google_project_service.cloudresourcemanager,
    google_project_service.serviceusage,
  ]
}

locals {
  workload_identity_pool = "${var.project_id}.svc.id.goog"
}

# Autopilot cluster with Workload Identity
resource "google_container_cluster" "awfl" {
  name     = var.cluster_name
  location = var.region
  project  = var.project_id

  deletion_protection = false

  # Autopilot enable flag (provider expects a top-level bool)
  enable_autopilot = true

  workload_identity_config {
    workload_pool = local.workload_identity_pool
  }

  depends_on = [google_project_service.container]
}

# -----------------------------------------------------------------------------
# Workload Identity IAM bindings (KSA -> GSA) for producer/consumer
# KSA principals are of the form: serviceAccount:${PROJECT}.svc.id.goog[namespace/ksa]
# -----------------------------------------------------------------------------

resource "google_service_account_iam_member" "producer_wi_user" {
  service_account_id = google_service_account.producer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${local.workload_identity_pool}[${var.k8s_namespace}/${var.producer_ksa_name}]"
  depends_on         = [google_container_cluster.awfl]
}

resource "google_service_account_iam_member" "consumer_wi_user" {
  service_account_id = google_service_account.consumer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${local.workload_identity_pool}[${var.k8s_namespace}/${var.consumer_ksa_name}]"
  depends_on         = [google_container_cluster.awfl]
}

# -----------------
# Variables
# -----------------
variable "cluster_name" {
  description = "GKE Autopilot cluster name"
  type        = string
  default     = "awfl-gke"
}

variable "k8s_namespace" {
  description = "Default Kubernetes namespace that will host the KSAs"
  type        = string
  default     = "awfl"
}

variable "producer_ksa_name" {
  description = "Kubernetes Service Account name for the producer"
  type        = string
  default     = "producer"
}

variable "consumer_ksa_name" {
  description = "Kubernetes Service Account name for the consumer"
  type        = string
  default     = "consumer"
}

# -----------------
# Outputs
# -----------------
output "gke_cluster_name" {
  description = "Name of the created GKE Autopilot cluster"
  value       = google_container_cluster.awfl.name
}

output "gke_cluster_location" {
  description = "Location (region) of the cluster"
  value       = google_container_cluster.awfl.location
}

output "workload_identity_pool" {
  description = "Workload Identity pool in the project"
  value       = local.workload_identity_pool
}
