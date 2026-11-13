# One persistent native Jobs scheduler in the existing AWFL GKE cluster.
# Workloads are initiated by the authenticated Workflows API; this pod does
# not expose a public endpoint or accept user-supplied workflow binaries.
# All infrastructure and GKE/SA IAM live in this existing remote TF state.

variable "native_jobs_image" {
  description = "Immutable server image deployed to Jobs Cloud Run and this GKE scheduler"
  type        = string
  validation {
    condition     = can(regex("^us-central1-docker[.]pkg[.]dev/awfl-us/app/api:[0-9a-f]{40}$", var.native_jobs_image))
    error_message = "native_jobs_image must be the immutable SHA-tagged AWFL server image."
  }
}

data "google_client_config" "native_scheduler" {}

data "google_container_cluster" "native_scheduler" {
  project  = var.project_id
  name     = "awfl-gke"
  location = var.region
}

provider "kubernetes" {
  host                   = "https://${data.google_container_cluster.native_scheduler.endpoint}"
  token                  = data.google_client_config.native_scheduler.access_token
  cluster_ca_certificate = base64decode(data.google_container_cluster.native_scheduler.master_auth[0].cluster_ca_certificate)
}

# Use the same authorized identity as the existing Cloud Run Jobs service.
# The Jobs sidecar itself is private to GKE; IAM on Cloud Run Jobs remains in
# main.tf. Workload Identity avoids user credentials or JSON SA keys.
resource "google_service_account_iam_member" "native_scheduler_workload_identity" {
  service_account_id = "projects/${var.project_id}/serviceAccounts/${local.runtime_sa}"
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[awfl/native-jobs]"
}

resource "kubernetes_service_account_v1" "native_scheduler" {
  metadata {
    name      = "native-jobs"
    namespace = "awfl"
    annotations = {
      "iam.gke.io/gcp-service-account" = local.runtime_sa
    }
    labels = {
      app = "awfl-native-jobs"
    }
  }
  depends_on = [google_service_account_iam_member.native_scheduler_workload_identity]
}

resource "kubernetes_deployment_v1" "native_scheduler" {
  metadata {
    name      = "native-jobs"
    namespace = "awfl"
    labels = {
      app = "awfl-native-jobs"
    }
  }
  wait_for_rollout = true

  spec {
    replicas = 1
    strategy {
      type = "Recreate"
    }
    selector {
      match_labels = {
        app = "awfl-native-jobs"
      }
    }
    template {
      metadata {
        labels = {
          app = "awfl-native-jobs"
        }
      }
      spec {
        service_account_name             = kubernetes_service_account_v1.native_scheduler.metadata[0].name
        termination_grace_period_seconds = 45

        container {
          name              = "jobs"
          image             = var.native_jobs_image
          image_pull_policy = "Always"

          port {
            name           = "http"
            container_port = 8080
          }
          env {
            name  = "SERVICE_TARGET"
            value = "start:jobs"
          }
          env {
            name  = "PORT"
            value = "8080"
          }
          env {
            name  = "NODE_ENV"
            value = "production"
          }
          env {
            name  = "GCP_PROJECT"
            value = var.project_id
          }
          env {
            name  = "GOOGLE_CLOUD_PROJECT"
            value = var.project_id
          }
          env {
            name  = "AWFL_NATIVE_EXECUTION_ENABLED"
            value = "1"
          }
          env {
            name  = "AWFL_NATIVE_DETACHED_GKE_ENABLED"
            value = "1"
          }
          env {
            name  = "AWFL_NATIVE_PERSISTENT_WORKER"
            value = "1"
          }
          env {
            name  = "AWFL_NATIVE_ARTIFACT_BUCKET"
            value = "${var.project_id}-native-workflows"
          }
          env {
            name  = "AWFL_NATIVE_JOBS_URL"
            value = "https://jobs-4wmfqir74q-uc.a.run.app"
          }
          env {
            name  = "WORKFLOWS_BASE_URL"
            value = "https://jobs-4wmfqir74q-uc.a.run.app"
          }
          env {
            name  = "WORKFLOWS_LOCATION"
            value = var.region
          }
          env {
            name  = "ALLOW_SKIP_AUTH"
            value = "0"
          }

          resources {
            requests = {
              cpu               = "1000m"
              memory            = "2Gi"
              ephemeral-storage = "1Gi"
            }
            limits = {
              cpu               = "2000m"
              memory            = "4Gi"
              ephemeral-storage = "2Gi"
            }
          }

          readiness_probe {
            http_get {
              path = "/health"
              port = 8080
            }
            initial_delay_seconds = 10
            period_seconds        = 10
          }
          liveness_probe {
            http_get {
              path = "/health"
              port = 8080
            }
            initial_delay_seconds = 30
            period_seconds        = 20
          }
        }
      }
    }
  }
  depends_on = [google_service_account_iam_member.native_scheduler_workload_identity]
}

output "native_scheduler_deployment" {
  value = kubernetes_deployment_v1.native_scheduler.metadata[0].name
}
