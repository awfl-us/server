# Minimal GKE Autopilot cluster and Workload Identity wiring
# Notes:
# - Reuses existing service accounts from infra/iam.tf:
#     - google_service_account.producer
#     - google_service_account.consumer (used by both Cloud Run consumer job and GKE consumer pods)
# - Creates required Kubernetes resources (namespace, KSAs, and RBAC) so the main Cloud Run
#   service (running as the awfl-consumer GSA) can create Jobs in the target namespace, and
#   KSAs are in place with WI annotations for in-cluster pods.

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

# Client config for obtaining an OAuth access token during terraform apply (for kubernetes provider)
data "google_client_config" "default" {}

# Project lookup to derive the default compute service account email (uses project number)
data "google_project" "project" {
  project_id = var.project_id
}

locals {
  workload_identity_pool   = "${var.project_id}.svc.id.goog"
  default_compute_sa_email = "${data.google_project.project.number}-compute@developer.gserviceaccount.com"
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
# Kubernetes provider targeting the created cluster
# NOTE: This requires that 'gcloud auth application-default login' or equivalent
# credentials are available when running terraform apply.
# -----------------------------------------------------------------------------
provider "kubernetes" {
  host                   = "https://${google_container_cluster.awfl.endpoint}"
  cluster_ca_certificate = base64decode(google_container_cluster.awfl.master_auth[0].cluster_ca_certificate)
  token                  = data.google_client_config.default.access_token
}

# -----------------------------------------------------------------------------
# Kubernetes objects: namespace + KSAs expected by jobs (producer/consumer)
# -----------------------------------------------------------------------------
resource "kubernetes_namespace" "awfl" {
  metadata {
    name = var.k8s_namespace
  }
  depends_on = [google_container_cluster.awfl]
}

resource "kubernetes_service_account" "producer" {
  metadata {
    name      = var.producer_ksa_name
    namespace = kubernetes_namespace.awfl.metadata[0].name
    annotations = {
      # Bind KSA -> GSA for Workload Identity
      "iam.gke.io/gcp-service-account" = google_service_account.producer.email
    }
  }
  depends_on = [kubernetes_namespace.awfl]
}

resource "kubernetes_service_account" "consumer" {
  metadata {
    name      = var.consumer_ksa_name
    namespace = kubernetes_namespace.awfl.metadata[0].name
    annotations = {
      # Bind KSA -> GSA for Workload Identity (same GSA used by Cloud Run consumer job)
      "iam.gke.io/gcp-service-account" = google_service_account.consumer.email
    }
  }
  depends_on = [kubernetes_namespace.awfl]
}

# -----------------------------------------------------------------------------
# Workload Identity IAM bindings (KSA -> GSA) for producer/consumer
# KSA principals are of the form: serviceAccount:${PROJECT}.svc.id.goog[namespace/ksa]
# -----------------------------------------------------------------------------
resource "google_service_account_iam_member" "producer_wi_user" {
  service_account_id = google_service_account.producer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${local.workload_identity_pool}[${var.k8s_namespace}/${var.producer_ksa_name}]"
  depends_on         = [google_container_cluster.awfl, kubernetes_service_account.producer]
}

resource "google_service_account_iam_member" "consumer_wi_user" {
  service_account_id = google_service_account.consumer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${local.workload_identity_pool}[${var.k8s_namespace}/${var.consumer_ksa_name}]"
  depends_on         = [google_container_cluster.awfl, kubernetes_service_account.consumer]
}

# -----------------------------------------------------------------------------
# RBAC: allow the Cloud Run service identity (awfl-consumer GSA) to launch Jobs in namespace
# Ensure your Cloud Run service is configured to run as google_service_account.consumer.email
# -----------------------------------------------------------------------------
resource "kubernetes_role" "job_launcher" {
  metadata {
    name      = "awfl-job-launcher"
    namespace = kubernetes_namespace.awfl.metadata[0].name
  }
  rule {
    api_groups = ["batch"]
    resources  = ["jobs"]
    verbs      = ["create", "get", "list", "watch", "delete"]
  }
  rule {
    api_groups = [""]
    resources  = ["pods"]
    verbs      = ["get", "list", "watch", "delete"]
  }
  rule {
    api_groups = [""]
    resources  = ["events"]
    verbs      = ["get", "list", "watch"]
  }
  depends_on = [kubernetes_namespace.awfl]
}

resource "kubernetes_role_binding" "job_launcher_binding" {
  metadata {
    name      = "awfl-job-launcher-binding"
    namespace = kubernetes_namespace.awfl.metadata[0].name
  }
  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "Role"
    name      = kubernetes_role.job_launcher.metadata[0].name
  }
  subject {
    kind      = "User"
    name      = google_service_account.consumer.email
    api_group = "rbac.authorization.k8s.io"
  }
  depends_on = [kubernetes_role.job_launcher]
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
