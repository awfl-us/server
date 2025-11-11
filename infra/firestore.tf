# Firestore (Native) database and API enablement

# Location for Firestore database. Immutable after creation.
# Recommended multi-region defaults: nam5 (North America), eur3 (Europe)
# You can also use regional locations like us-central1, europe-west3, etc.
variable "firestore_location" {
  description = "Firestore database location_id (e.g., nam5, eur3, us-central1). Immutable once created."
  type        = string
  default     = "nam5"
}

# Enable Firestore API
resource "google_project_service" "firestore" {
  project            = var.project_id
  service            = "firestore.googleapis.com"
  disable_on_destroy = false
  depends_on = [
    google_project_service.cloudresourcemanager,
    google_project_service.serviceusage,
  ]
}

# Create the default Firestore database in Native mode
# NOTE: The default database ID must be "(default)". Location is immutable.
resource "google_firestore_database" "default" {
  project     = var.project_id
  name        = "(default)"
  location_id = var.firestore_location
  type        = "FIRESTORE_NATIVE"

  depends_on = [google_project_service.firestore]

  lifecycle {
    # Avoid accidental deletion of the Firestore database via Terraform
    prevent_destroy = true
  }
}

output "firestore_database_name" {
  description = "Name/ID of the Firestore database (usually (default))."
  value       = google_firestore_database.default.name
}
