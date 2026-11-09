terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 7.10.0, < 8.0.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.35"
    }
  }
  backend "gcs" {
    bucket = "tfstate-awfl-web"
    prefix = "infra/gke-guardrails"
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

variable "cluster_name" {
  type    = string
  default = "awfl-gke"
}

variable "k8s_namespace" {
  type    = string
  default = "awfl"
}

provider "google" {
  project = var.project_id
  region  = var.region
}

data "google_container_cluster" "awfl" {
  project  = var.project_id
  location = var.region
  name     = var.cluster_name
}

data "google_client_config" "k8s" {}

provider "kubernetes" {
  host                   = "https://${data.google_container_cluster.awfl.endpoint}"
  token                  = data.google_client_config.k8s.access_token
  cluster_ca_certificate = base64decode(data.google_container_cluster.awfl.master_auth[0].cluster_ca_certificate)
}
