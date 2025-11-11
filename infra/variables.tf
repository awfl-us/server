# Shared variables for infra

# Base project_id is defined in iam.tf and reused by providers.

variable "region" {
  description = "Primary region for serverless services"
  type        = string
  default     = "us-central1"
}

variable "root_domain" {
  description = "Root DNS domain to manage in Cloud DNS (e.g., awfl.us)"
  type        = string
}

# Name of the Artifact Registry repository to host container images
variable "ar_repo_name" {
  description = "Artifact Registry repository name for Docker images"
  type        = string
  default     = "containers"
}

# GitHub repository that is allowed to assume the deploy service account via WIF
# Format: "owner/repo" (e.g., "awfl/awfl")
variable "github_repository" {
  description = "GitHub repository (owner/repo) allowed to deploy via OIDC Workload Identity Federation"
  type        = string
}

# Whether Cloud Run services (api, jobs) already exist in the project/region.
# When true, enable resources and lookups that require the services to exist (e.g.,
# Cloud Run Domain Mappings, DNS records, and service URL data sources).
# Keep false for the very first apply prior to deploying services via CI/CD.
variable "cloud_run_services_exist" {
  description = "Toggle features that require existing Cloud Run services (domain mappings, DNS, data lookups)"
  type        = bool
  default     = false
}

# Control whether to attempt Google Search Console site verification during apply.
# When false (default), Terraform will create the Cloud DNS zone and the TXT verification record
# but will NOT attempt to claim ownership (which can block while nameserver delegation propagates).
# After you have set your registrar nameservers to the Cloud DNS zone values and propagation is complete,
# re-run with -var enable_site_verification=true to claim the domain.
variable "enable_site_verification" {
  description = "Attempt to claim domain ownership via Site Verification API during apply (may block while DNS propagates)"
  type        = bool
  default     = false
}

# ------------------------------
# Remote state settings for the web (frontend) stack
# ------------------------------
variable "web_tfstate_bucket_name" {
  description = "GCS bucket name that hosts the web (frontend) Terraform state"
  type        = string
  # Default provided per user: the web repo manages this bucket
  default     = "tfstate-awfl-web"
}

variable "web_tfstate_prefix" {
  description = "Object prefix (folder) within the web state bucket (e.g., workspace path)"
  type        = string
  # Default provided per user for prod
  default     = "infra/envs/prod"
}

# ------------------------------
# DNS defaults
# ------------------------------
variable "dns_default_ttl" {
  description = "Default TTL (seconds) to apply to DNS records when TTL is not provided by remote state"
  type        = number
  default     = 300
}
