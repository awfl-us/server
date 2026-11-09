# Hard Kubernetes admission limits for the existing 'awfl' namespace.
# These limit the aggregate billed workload, not the Google Cloud bill in USD.
# Cluster-admin identities could evade namespace limits by creating new namespaces.

resource "kubernetes_resource_quota_v1" "awfl_compute_ceiling" {
  metadata {
    name      = "awfl-compute-ceiling"
    namespace = var.k8s_namespace
  }

  spec {
    hard = {
      "pods"                       = tostring(var.gke_max_pods)
      "count/jobs.batch"           = tostring(var.gke_max_jobs)
      "requests.cpu"               = var.gke_max_requested_cpu
      "requests.memory"            = var.gke_max_requested_memory
      "requests.ephemeral-storage" = var.gke_max_requested_ephemeral_storage
    }
  }

}

resource "kubernetes_limit_range_v1" "awfl_container_ceiling" {
  metadata {
    name      = "awfl-container-ceiling"
    namespace = var.k8s_namespace
  }

  spec {
    limit {
      type = "Container"
      max = {
        cpu                 = var.gke_max_container_cpu
        memory              = var.gke_max_container_memory
        "ephemeral-storage" = var.gke_max_container_ephemeral_storage
      }
      default = {
        cpu                 = var.gke_max_container_cpu
        memory              = var.gke_max_container_memory
        "ephemeral-storage" = var.gke_max_container_ephemeral_storage
      }
      default_request = {
        cpu                 = "500m"
        memory              = "2Gi"
        "ephemeral-storage" = "1Gi"
      }
    }
  }

}

variable "gke_max_pods" {
  description = "Maximum non-terminal Pods in the AWFL namespace."
  type        = number
  default     = 20
  validation {
    condition     = var.gke_max_pods >= 1 && var.gke_max_pods <= 20
    error_message = "gke_max_pods must be between 1 and 20."
  }
}

variable "gke_max_jobs" {
  description = "Maximum Job objects, including completed Jobs awaiting cleanup."
  type        = number
  default     = 25
}

variable "gke_max_requested_cpu" {
  description = "Maximum aggregate requested vCPU in the namespace."
  type        = string
  default     = "10"
}

variable "gke_max_requested_memory" {
  description = "Maximum aggregate requested memory."
  type        = string
  default     = "40Gi"
}

variable "gke_max_requested_ephemeral_storage" {
  description = "Maximum aggregate requested ephemeral storage."
  type        = string
  default     = "20Gi"
}

variable "gke_max_container_cpu" {
  description = "Maximum vCPU per container."
  type        = string
  default     = "2"
}

variable "gke_max_container_memory" {
  description = "Maximum memory per container."
  type        = string
  default     = "4Gi"
}

variable "gke_max_container_ephemeral_storage" {
  description = "Maximum ephemeral storage per container."
  type        = string
  default     = "2Gi"
}
