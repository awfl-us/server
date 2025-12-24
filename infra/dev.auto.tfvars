project_id        = "cornerstoneai-org"
root_domain       = "cornerstoneai.org"
github_repository = "cornerstone-ai/awfl-server"

cloud_run_services_exist = true
enable_site_verification = true

# Allow LAN dev from Vite served over http://<LAN-IP>:5173
# Tip: prefer a stable mDNS host (e.g., my-mac.local) when possible to avoid updating this frequently.
authorized_domains_extra = [
  "192.168.1.153"
]

# Optional: Firestore database location (immutable after creation)
# Multi-region recommended: nam5 (North America) or eur3 (Europe)
# Regional examples: us-central1, europe-west3
# firestore_location = "nam5"

# Optional: project roles to grant to the local dev service account
# project_roles = [
#   "roles/datastore.user",
#   "roles/storage.objectViewer"
# ]

firebase_web_app_display_name = "cornerstoneai-web"

web_tfstate_bucket_name = "tfstate-cornerstone-web"
