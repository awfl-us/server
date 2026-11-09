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
    prefix = "infra/workspace-storage"
  }
}

provider "google" {
  project = "awfl-us"
  region  = "us-central1"
}

data "google_project" "current" {
  project_id = "awfl-us"
}

# This bucket existed before this module. Import it into this dedicated state;
# do not create a second bucket or let the old root own it simultaneously.
resource "google_storage_bucket" "workspaces" {
  name                        = "awfl-us-work-bucket"
  location                    = "US"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }

  # No age-based deletion of current workspace files.
  lifecycle {
    prevent_destroy = true
  }
}

# The API service brokers prefix-scoped, short-lived CAB tokens. The GKE
# consumer itself is NOT granted unrestricted access to this bucket.
resource "google_storage_bucket_iam_member" "api_token_broker" {
  bucket = google_storage_bucket.workspaces.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${data.google_project.current.number}-compute@developer.gserviceaccount.com"
}

output "workspace_bucket" {
  value = google_storage_bucket.workspaces.name
}
