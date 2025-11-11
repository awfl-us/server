variable "firebase_web_app_display_name" {
  description = "Display name for the Firebase Web App"
  type        = string
  default     = "awfl-web"
}

# Enable necessary Firebase services
resource "google_project_service" "firebase" {
  project            = var.project_id
  service            = "firebase.googleapis.com"
  disable_on_destroy = false
  depends_on = [
    google_project_service.cloudresourcemanager,
    google_project_service.serviceusage,
  ]
}

resource "google_project_service" "identitytoolkit" {
  project            = var.project_id
  service            = "identitytoolkit.googleapis.com"
  disable_on_destroy = false
  depends_on = [
    google_project_service.cloudresourcemanager,
    google_project_service.serviceusage,
  ]
}

# Add Firebase to existing GCP project
resource "google_firebase_project" "default" {
  provider = google-beta
  project  = var.project_id

  depends_on = [
    google_project_service.firebase
  ]
}

# Create a Firebase Web App
resource "google_firebase_web_app" "web" {
  provider     = google-beta
  project      = var.project_id
  display_name = var.firebase_web_app_display_name

  depends_on = [google_firebase_project.default]

  lifecycle {
    prevent_destroy = true
  }
}

# Fetch Web App client configuration
data "google_firebase_web_app_config" "web" {
  provider   = google-beta
  web_app_id = google_firebase_web_app.web.app_id
}

# Configure Firebase Auth authorized domains so OAuth redirects work locally and on Firebase Hosting
# Note: If you manage authorized domains here, include the default Firebase Hosting domains
# to avoid accidental removal in the console.
resource "google_identity_platform_config" "default" {
  provider = google-beta
  project  = var.project_id

  authorized_domains = [
    "localhost",                    # local dev (all ports, e.g., Vite 5173)
    "127.0.0.1",                    # loopback
    var.root_domain,
    "www.${var.root_domain}",
    "${var.project_id}.firebaseapp.com", # default Firebase Hosting domain
    "${var.project_id}.web.app"          # default Firebase Hosting domain
  ]

  depends_on = [
    google_project_service.identitytoolkit,
    google_firebase_project.default
  ]
}

# Output individual config values
output "firebase_web_app_api_key" {
  description = "Firebase Web App apiKey (public client key)"
  value       = data.google_firebase_web_app_config.web.api_key
}

output "firebase_web_app_auth_domain" {
  description = "Firebase Auth domain"
  value       = data.google_firebase_web_app_config.web.auth_domain
}

output "firebase_web_app_app_id" {
  description = "Firebase Web App appId"
  value       = google_firebase_web_app.web.app_id
}

# Vite-compatible .env snippet for easy copy/paste
output "firebase_vite_env" {
  description = "Lines suitable for a Vite .env file"
  value = <<EOT
VITE_FIREBASE_API_KEY=${data.google_firebase_web_app_config.web.api_key}
VITE_FIREBASE_AUTH_DOMAIN=${data.google_firebase_web_app_config.web.auth_domain}
VITE_FIREBASE_PROJECT_ID=${var.project_id}
VITE_FIREBASE_APP_ID=${google_firebase_web_app.web.app_id}
VITE_FIREBASE_MESSAGING_SENDER_ID=${data.google_firebase_web_app_config.web.messaging_sender_id}
VITE_FIREBASE_MEASUREMENT_ID=${data.google_firebase_web_app_config.web.measurement_id}
EOT
}
