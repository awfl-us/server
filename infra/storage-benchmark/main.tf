terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google      = { source = "hashicorp/google", version = ">= 7.10.0, < 8.0.0" }
    google-beta = { source = "hashicorp/google-beta", version = ">= 7.10.0, < 8.0.0" }
  }
  backend "gcs" {
    bucket = "tfstate-awfl-web"
    prefix = "infra/storage-benchmark"
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
variable "client_service_account" {
  type    = string
  default = "awfl-consumer@awfl-us.iam.gserviceaccount.com"
}
variable "runtime_service_account" {
  type        = string
  description = "Cloud Run API/Jobs and native-jobs GKE Workload Identity runtime"
  default     = "323709301334-compute@developer.gserviceaccount.com"
}
variable "benchmark_user_email" {
  type        = string
  description = "Optional Google account permitted to connect via Cloud SQL IAM authentication"
  default     = ""
}

provider "google" {
  project = var.project_id
  region  = var.region
}
provider "google-beta" {
  project = var.project_id
  region  = var.region
}

resource "google_project_service" "sqladmin" {
  project            = var.project_id
  service            = "sqladmin.googleapis.com"
  disable_on_destroy = false
}
resource "google_project_service" "rtdb" {
  project            = var.project_id
  service            = "firebasedatabase.googleapis.com"
  disable_on_destroy = false
}

resource "google_firebase_database_instance" "benchmark" {
  provider    = google-beta
  project     = var.project_id
  region      = var.region
  instance_id = "awfl-native-storage-bench"
  type        = "USER_DATABASE"
  depends_on  = [google_project_service.rtdb]
}

# Database rules are not exposed as a Terraform resource by the provider.
# Terraform owns this one-time rules deployment via a local-exec provisioner.
resource "terraform_data" "lockdown_rtdb" {
  triggers_replace = [google_firebase_database_instance.benchmark.id,
  filesha256("${path.module}/deny-all-rtdb-rules.json")]
  provisioner "local-exec" {
    command = "bash ${path.module}/set-rtdb-rules.sh '${google_firebase_database_instance.benchmark.database_url}' '${path.module}/deny-all-rtdb-rules.json'"
  }
}

resource "google_sql_database_instance" "benchmark" {
  project             = var.project_id
  name                = "awfl-native-storage-bench"
  region              = var.region
  database_version    = "POSTGRES_15"
  deletion_protection = true
  depends_on          = [google_project_service.sqladmin]
  settings {
    edition           = "ENTERPRISE"
    tier              = "db-f1-micro"
    availability_type = "ZONAL"
    activation_policy = "ALWAYS"
    disk_size         = 10
    disk_type         = "PD_SSD"
    disk_autoresize   = true
    backup_configuration {
      enabled                        = true
      start_time                     = "06:00"
      point_in_time_recovery_enabled = true
      backup_retention_settings {
        retained_backups = 7
        retention_unit   = "COUNT"
      }
    }
    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }
    ip_configuration {
      ipv4_enabled = true
      # No authorized networks: connectivity exclusively via Cloud SQL proxy.
    }
    user_labels = { purpose = "storage-benchmark-and-prod", app = "awfl" }
  }
}
resource "google_sql_database" "benchmark" {
  project  = var.project_id
  instance = google_sql_database_instance.benchmark.name
  name     = "awfl_bench"
}

# Separate production database on the existing Terraform-owned instance.
# No second database service, no state import or destroy/recreate.
resource "google_sql_database" "production" {
  project  = var.project_id
  instance = google_sql_database_instance.benchmark.name
  name     = "awfl_prod"
}

# API/Jobs and persistent native GKE Jobs share the existing runtime service
# account via Workload Identity. IAM DB auth never uses plaintext passwords.
resource "google_sql_user" "runtime" {
  project        = var.project_id
  instance       = google_sql_database_instance.benchmark.name
  name           = trimsuffix(var.runtime_service_account, ".gserviceaccount.com")
  type           = "CLOUD_IAM_SERVICE_ACCOUNT"
  database_roles = ["cloudsqlsuperuser"]
}

resource "google_project_iam_member" "runtime_cloudsql_connect" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${var.runtime_service_account}"
}
resource "google_project_iam_member" "runtime_cloudsql_login" {
  project = var.project_id
  role    = "roles/cloudsql.instanceUser"
  member  = "serviceAccount:${var.runtime_service_account}"
}
resource "google_sql_user" "benchmark" {
  project        = var.project_id
  instance       = google_sql_database_instance.benchmark.name
  name           = trimsuffix(var.client_service_account, ".gserviceaccount.com")
  type           = "CLOUD_IAM_SERVICE_ACCOUNT"
  database_roles = ["cloudsqlsuperuser"]
}
resource "google_sql_user" "benchmark_user" {
  count    = var.benchmark_user_email == "" ? 0 : 1
  project  = var.project_id
  instance = google_sql_database_instance.benchmark.name
  name     = var.benchmark_user_email
  type     = "CLOUD_IAM_USER"
}
resource "google_project_iam_member" "bench_user_cloudsql_connect" {
  count   = var.benchmark_user_email == "" ? 0 : 1
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "user:${var.benchmark_user_email}"
}
resource "google_project_iam_member" "bench_user_cloudsql_login" {
  count   = var.benchmark_user_email == "" ? 0 : 1
  project = var.project_id
  role    = "roles/cloudsql.instanceUser"
  member  = "user:${var.benchmark_user_email}"
}

resource "google_project_iam_member" "bench_cloudsql_connect" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${var.client_service_account}"
}
resource "google_project_iam_member" "bench_cloudsql_login" {
  project = var.project_id
  role    = "roles/cloudsql.instanceUser"
  member  = "serviceAccount:${var.client_service_account}"
}
output "production_database_name" {
  value = google_sql_database.production.name
}
output "production_database_user" {
  value = google_sql_user.runtime.name
}
output "postgres_instance_connection_name" {
  value = google_sql_database_instance.benchmark.connection_name
}
output "postgres_user" {
  value = google_sql_user.benchmark.name
}
output "rtdb_database_url" {
  value = google_firebase_database_instance.benchmark.database_url
}
