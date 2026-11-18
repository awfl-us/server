# Restricted, short-lived diagnostic captures of full OpenAI request bodies.
variable "openai_capture_runtime_service_account" {
  description = "Cloud Run Jobs runtime service account allowed to write diagnostic captures"
  type        = string
  default     = null
}

resource "google_storage_bucket" "openai_context_capture" {
  name                        = "${"awfl-us"}-openai-context-capture"
  project                     = "awfl-us"
  location                    = "US-CENTRAL1"
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  lifecycle_rule {
    condition { age = 7 }
    action { type = "Delete" }
  }

}

# The existing Cloud Run runtime identity is the project default compute SA.

resource "google_storage_bucket_iam_member" "openai_capture_writer" {
  bucket = google_storage_bucket.openai_context_capture.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${coalesce(var.openai_capture_runtime_service_account, "${data.google_project.current.number}-compute@developer.gserviceaccount.com")}"
}
