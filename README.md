# AWFL Server

Overview
- This repository provides the HTTP server that powers both frontend clients (awfl-us/web and awfl-us/cli) and the backend workflows (awfl-us/workflows) used by the AWFL stack.
- It exposes two primary route groups:
  - /api/workflows: client-facing workflow APIs used by web and CLI
  - /jobs: internal jobs and services used by workflows and background tasks
- Local development includes an optional Firestore emulator and an Nginx router for proxying.

Quick start: Local development with the AWFL CLI
- This is the fastest way to bring up the server locally and integrate with the rest of the stack.

Prerequisites
- Python 3.11+
- pipx installed (https://pypa.github.io/pipx/)
- Docker and Docker Compose
- Node.js 22+ (required by this server)

Steps
1) Install the CLI
- pipx install awfl
- Verify: awfl --version

2) Start the dev environment (first run guided setup)
- From this repo root, launch the CLI: awfl
- At the awfl prompt, run: dev start
- On first run, you’ll see a few prompts to set up your local dev workflow. Typical prompts include:
  - Start Docker Compose for the server and dependencies? (recommended: Yes)
  - Start an ngrok https tunnel so external webhooks can reach your dev server? (optional)
  - Start the workflows watcher to regenerate YAMLs (requires awfl-us/workflows) and auto-deploy changes? (optional; requires gcloud)
  - Save these choices as your defaults? (Yes saves a local dev config; you can override any choice later with CLI flags)
- Notes:
  - Next runs reuse your saved answers; precedence is CLI flags > saved config > environment/defaults.
  - dev status shows resolved settings and current process state.
  - dev stop tears down anything started by the CLI session.

3) Validate
- Health check: http://localhost:5050/api/health
- If you enabled ngrok, the tunnel URL is printed by the CLI and visible via dev status.

4) Stop
- In the awfl prompt: dev stop
- If you started Docker manually/outside the CLI, use docker compose down as needed.

Key directories
- serve.js: Entrypoint Express server
- jobs/: Job routes (internal services mounted under /jobs)
- workflows/: Workflow orchestrations and client-facing workflow routes (mounted under /api/workflows)
- infra/: Terraform IaC to provision GCP roles/services for the server

Primary services and consumers
- awfl-us/web (frontend)
  - Calls /api/workflows/* for workflow APIs
  - May call /jobs/* in dev or internal tools contexts
- awfl-us/cli (frontend)
  - Calls /api/workflows/* and certain /jobs/* helpers
- awfl-us/workflows (backend library within this repo)
  - Provides workflow orchestration, tools, context assembly, tasks, and event ingestion

API surface (high-level)
- GET /api/health: health check
- /api/workflows/*: workflow execution, definitions, and tools
- /jobs/*: internal services used by workflows
  - /jobs/tools/*: shared tools API
  - /jobs/agents/*: agent modules
  - /jobs/events/*: event ingestion
  - /jobs/tasks/*: task tracking
  - /jobs/context/*: context assembly and collapse indexer
    - POST /jobs/context/topicContextYoj/run
    - POST /jobs/context/collapse/indexer/run (mounted under /collapse/indexer/run)

Context module (defaults and notes)
- TopicContextYoj builds request/response context windows from configured components and applies a filter pipeline.
- General default filter order: [ sizeLimiter, toolCallBackfill ]
  - sizeLimiter trims to token budget (default maxTokens ~24000)
  - toolCallBackfill normalizes tool-call sequences and backfills missing tool replies
- TopicContext preset filter order: [ collapseGroupReplacer, fileContentsLimiter, sizeLimiter, toolCallBackfill ]
  - collapseGroupReplacer shrinks sequences into placeholders using user/session-scoped collapse data
  - sizeLimiter uses a tighter budget by default (maxTokens ~20000)

Prerequisites
- Node.js 22+
- Docker and Docker Compose
- Firebase CLI (for local Firestore emulator)
- Terraform > 1.6
- gcloud CLI (for deployment to GCP)

Environment configuration
- Copy .env.example to .env and fill in values you need for local development:
  - GOOGLE_MAPS_API_KEY, OPENAI_API_KEY, optional GITHUB_TOKEN, NODE_ENV
- Service account credentials (GCP):
  - Option A (Docker recommended): place serviceAccountKey.json at repo root (not committed) and it will be mounted into the container at /app/serviceAccountKey.json.
  - Option B (local node): use ADC via gcloud auth application-default login or set GOOGLE_APPLICATION_CREDENTIALS pointing to your key file.
- Safety: never commit real secrets. .env.example is safe to commit; .env and serviceAccountKey.json should be local-only.

Local development
- Using Docker (recommended):
  - docker compose up --build
  - Health check: http://localhost:5050/api/health
  - Nginx router exposes 8081 if needed by your setup
- Without Docker:
  - npm install
  - PORT=5050 node serve.js
  - Ensure FIRESTORE_EMULATOR_HOST or real Firestore access is configured as appropriate

Frontend integration
- Set BASE_URL for clients to point to the server, e.g., http://localhost:5050 in development.
- Web and CLI clients primarily call /api/workflows/* and may also call /jobs/* where needed.

Infrastructure (Terraform)
- Goal: provision GCP IAM roles and related resources required by the server/workflows.
- Variables:
  - project_id (non-secret)
  - firestore_location (optional; default "nam5". Immutable after creation.)
  - firebase_web_app_display_name (optional; default "awfl-web")
  - root_domain (required for DNS)
  - enable_site_verification (default false; see DNS bootstrap below)
  - cloud_run_services_exist (default false; see domain mappings)
- Provisioned services/resources:
  - IAM: local dev service account and optional project role bindings
  - Firestore: enables firestore.googleapis.com and creates the default Firestore database in Native mode with lifecycle.prevent_destroy = true
  - Firebase: enables firebase.googleapis.com and identitytoolkit.googleapis.com, adds Firebase to the project, and creates a Firebase Web App
  - DNS: Cloud DNS managed zone for root_domain and records for verification and Cloud Run mappings
  - Site Verification: optional ownership claim via DNS TXT when enabled
- Outputs:
  - service_account_email
  - service_account_key_json (sensitive)
  - firestore_database_name
  - firebase_web_app_api_key
  - firebase_web_app_auth_domain
  - firebase_web_app_app_id
  - firebase_web_client_config (combined map)
  - dns_nameservers (nameservers for your Cloud DNS zone)
- Setup steps:
  - cd infra
  - cp terraform.tfvars.example dev.auto.tfvars
  - Edit dev.auto.tfvars and set project_id = "YOUR_GCP_PROJECT_ID" (and optionally firestore_location, root_domain)
  - terraform init
  - Optional: configure remote state (recommended) before first apply:
    - Use a GCS backend bucket (not committed) to avoid local terraform.tfstate in git
  - terraform plan
  - terraform apply
- One-off alternative without files:
  - terraform apply -var="project_id=YOUR_GCP_PROJECT_ID" -var="root_domain=yourdomain.tld"
- Notes:
  - Firestore database location_id is immutable once created. Choose carefully (multi-region nam5/eur3 recommended).
  - If a Firestore database already exists in the project (or in Datastore mode), creation will fail; consider importing or reconciling manually.
  - Firebase Web App apiKey is a public client key and not a secret. Keep service account keys and secrets out of source control.
  - project_id is not sensitive; committing terraform.tfvars.example is safe. Keep dev.auto.tfvars local.
  - Do not commit terraform.tfstate; use remote state for teams/CI.

First-time DNS bootstrap: get Cloud DNS nameservers before apply completes
- Problem: The site verification resource may block while DNS propagates, but you need Cloud DNS nameservers to update your registrar first.
- Solutions to obtain nameservers immediately after the managed zone is created (you can do this while apply is running):
  - Cloud Console: Network services -> Cloud DNS -> Managed zones -> your zone -> copy the NS list
  - gcloud CLI:
    - gcloud dns managed-zones list
    - gcloud dns managed-zones describe ZONE_NAME --format="value(nameServers[])"
- Update the NS at your domain registrar to match the Cloud DNS zone’s nameservers.
- Once delegation propagates globally (often 5–30 minutes), site verification can succeed.

Non-blocking applies for DNS verification
- Toggle: enable_site_verification (default false)
  - When false: Terraform creates the Cloud DNS zone and the TXT record, but does NOT attempt to claim ownership. This avoids long blocking applies on first run.
  - When true: Terraform also creates google_site_verification_web_resource to claim ownership. The resource has a create timeout of 60m to allow for propagation.
  - Enable later:
    - terraform apply -var enable_site_verification=true
    - Or add to a local override file infra/dev.local.auto.tfvars (gitignored): enable_site_verification = true
- Two-phase apply alternative (targeted):
  - Phase 1: create just the DNS zone and TXT record
    - terraform apply \
      -target=google_dns_managed_zone.root \
      -target=google_dns_record_set.root_verification_txt
  - Update registrar nameservers using the Cloud DNS zone NS values (Console or gcloud as above). Wait for propagation.
  - Phase 2: full apply (and optionally enable_site_verification=true)

Using external DNS providers vs delegating to Cloud DNS
- If you will NOT delegate your domain to Cloud DNS (i.e., you keep another provider authoritative):
  - The TXT record inside Cloud DNS is not publicly visible until you change NS at the registrar. You must add the Google site verification TXT record at your authoritative DNS provider if you want to verify via DNS.
  - You can still run Terraform here with enable_site_verification=false to avoid blocking. When you are ready to verify, either:
    - Set enable_site_verification=true after you have created the TXT at your external provider, or
    - Verify domain ownership via another method in Search Console (HTML file / meta tag), outside Terraform.
  - Cloud Run domain mappings require domain ownership. Ensure verification is complete before enabling mappings.

Domain verification and Cloud Run domain mappings (two-step)
- ADC requirement for Site Verification API
  - The google provider uses ADC. To call the Site Verification API during apply, authenticate with a user credential that has the siteverification scope.
  - Run: gcloud auth application-default login --scopes=https://www.googleapis.com/auth/siteverification
    - This opens a browser and redirects to http://localhost:8085 for the OAuth callback. If a browser can’t be launched, use --no-launch-browser to copy/paste the URL.
    - To reset ADC later: gcloud auth application-default revoke (then login again as needed).
- Step 1: Create DNS zone and TXT (verification) record
  - In infra/dev.auto.tfvars, set root_domain = "yourdomain.tld".
  - Keep enable_site_verification = false for the first apply to avoid blocking, or use the two-phase apply above.
  - terraform apply will:
    - Create a public Cloud DNS managed zone for the root domain and output dns_nameservers.
    - Create the site verification TXT record in that zone.
  - At your domain registrar, set the nameservers for your root domain to the dns_nameservers output by Terraform (or retrieved via Console/gcloud).
  - Wait for DNS to propagate, then run terraform apply -var enable_site_verification=true to claim ownership.
- Step 2: Ensure services exist (created by CI on merge)
  - Merge to main so the GitHub Actions workflow deploys the Cloud Run services (api and jobs) in the configured region/project.
  - Confirm the service names match what infra expects (defaults are api and jobs; the domain mappings refer to these names).
- Step 3: Enable domain mappings and create CNAMEs
  - Domain ownership must already be verified (either via enable_site_verification=true or manual verification in Search Console) before creating mappings.
  - Do not commit this toggle; use a local override file that is gitignored:
    - Create infra/dev.local.auto.tfvars with: cloud_run_services_exist = true
  - terraform apply will then create:
    - google_cloud_run_domain_mapping resources for api.yourdomain and jobs.yourdomain
    - CNAME records pointing to ghs.googlehosted.com for those subdomains
  - After certificate provisioning completes (managed by Cloud Run), your subdomains should serve the respective services.

Migration note (infra variable rename)
- The old toggle enable_domain_mappings is replaced by cloud_run_services_exist (default false).
- Before the first deploy, keep cloud_run_services_exist = false so terraform apply succeeds without the Cloud Run services.
- After the initial deploy (services exist and domain ownership is verified), set cloud_run_services_exist = true via a local override file (infra/dev.local.auto.tfvars) or CLI: -var='cloud_run_services_exist=true'.
- The infra also now conditionally looks up Cloud Run service URLs for GitHub Actions variables. When false, WORKFLOWS_BASE_URL falls back to https://jobs.<root_domain>.

Firebase Web App (client config)
- After apply, retrieve outputs:
  - terraform output firebase_web_client_config
  - terraform output firebase_web_app_api_key
  - terraform output firebase_web_app_auth_domain
  - terraform output firebase_web_app_app_id
- Example client initialization (JS):
  const cfg = /* value of firebase_web_client_config */;
  import { initializeApp } from "firebase/app";
  import { getAuth, GoogleAuthProvider } from "firebase/auth";
  const app = initializeApp(cfg);
  const auth = getAuth(app);
  const provider = new GoogleAuthProvider();
  // signInWithPopup(auth, provider)
- Enable Google Sign-In provider in Firebase Console (Authentication -> Sign-in method) and add your app domain(s) to the authorized domains. This step is not currently managed by Terraform in this repo.

Deployment (example: Cloud Run)
- Build and push an image (Artifact Registry example):
  - gcloud builds submit --tag "us-central1-docker.pkg.dev/PROJECT_ID/REPOSITORY/awfl-server:TAG"
- Deploy to Cloud Run:
  - gcloud run deploy awfl-server \
    --image "us-central1-docker.pkg.dev/PROJECT_ID/REPOSITORY/awfl-server:TAG" \
    --platform managed \
    --region us-central1 \
    --allow-unauthenticated \
    --set-env-vars "NODE_ENV=production,WORKFLOW_ENV=Prod,BASE_URL=https://YOUR_DOMAIN" \
    --update-secrets "GOOGLE_APPLICATION_CREDENTIALS=projects/PROJECT_ID/secrets/SVC_KEY:latest"
- Ensure Firestore (or emulator in dev) and any external APIs are reachable from the environment.

Runtime secrets: Secret Manager + secrets.txt (for Cloud Run deploys)
- Overview
  - This repo’s GitHub Actions workflow (.github/workflows/deploy-cloud-run.yml) reads a secrets.txt file at the repo root and turns each line into a Cloud Run --set-secrets flag in the form ENV=SECRET_NAME:latest.
  - Secret names should match the environment variable names you want available in the container.
  - The workflow uses the latest version of each secret at deploy time.
- Prerequisites
  - Secret Manager API is enabled (managed by infra/apis.tf).
  - The Cloud Run runtime service account has roles/secretmanager.secretAccessor at the project level (managed by infra; default Compute Engine SA is granted this role).
- Create secrets (same project as the deployment)
  - Example (OPENAI_API_KEY):
    - gcloud secrets create OPENAI_API_KEY --replication-policy=automatic
    - echo -n "your-api-key" | gcloud secrets versions add OPENAI_API_KEY --data-file=-
  - Repeat for each secret you need. You can also create/update secrets from the Cloud Console.
- Add secret names to secrets.txt
  - Create a file named secrets.txt in the repo root (commit it; it contains only names, not values).
  - One secret name per line. Blank lines and lines starting with # are ignored.
  - Example contents:
    - # Secret names become ENV vars with the same name
    - OPENAI_API_KEY
    - GOOGLE_MAPS_API_KEY
- Deploy
  - Push to main (or your configured branch). The workflow will:
    - Build and push the image to Artifact Registry.
    - Deploy Cloud Run services with --set-secrets built from secrets.txt, mapping each name to :latest.
- Notes
  - This setup assumes secrets live in the same project as the Cloud Run services. Cross-project secrets would require adjusting the workflow to include a projects/PROJECT_ID/secrets/SECRET path.
  - Rotating a secret is just adding a new version; the workflow uses :latest so redeploys pick up the newest version.
  - If you see permission errors (403) at runtime or deploy:
    - Verify the secret exists in the project.
    - Ensure Terraform has been applied so the runtime service account has Secret Manager Secret Accessor.

Security and safety notes
- Never commit real secrets (OPENAI_API_KEY, GITHUB_TOKEN, serviceAccountKey.json).
- Prefer Google Secret Manager or your secret manager of choice for production.
- Keep Terraform state out of git; configure remote backend in GCS.
- Be mindful of request logs (the dev logger prints headers and body for non-/health requests).

Troubleshooting
- If the Firestore emulator is used, ensure ports 8085/4000 are available.
- For CORS/browser use, you may need to enable CORS middleware in serve.js for your origins.
- Check container health at /api/health and logs from docker compose.

License
- MIT (see LICENSE)
