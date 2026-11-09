terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 7.10.0, < 8.0.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = ">= 7.10.0, < 8.0.0"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.4"
    }
  }
}

provider "google" {
  project               = var.project_id
  # Ensure requests made with user ADC set the quota/billing project header
  user_project_override = true
  billing_project       = var.project_id

  # Request Site Verification scopes when using user ADC
  scopes = [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/siteverification"
  ]
}

provider "google-beta" {
  project               = var.project_id
  # Ensure requests made with user ADC set the quota/billing project header
  user_project_override = true
  billing_project       = var.project_id

  # Keep scopes consistent across providers
  scopes = [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/siteverification"
  ]
}

# local provider needed for local_file resource
provider "local" {}
