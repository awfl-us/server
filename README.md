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
  - enable_site_verification (default false; see DNS verification flag flow below)
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

DNS verification (simple flag flow)
- Goal: verify domain ownership via DNS without long blocking applies, using a single flag.
- How it works
  - enable_site_verification controls whether Terraform claims ownership using the Site Verification API.
  - Default false: creates the Cloud DNS zone and TXT record only.
  - Set true when DNS has propagated to claim ownership (resource has a 60m create timeout).
- Steps
  1) First apply with enable_site_verification = false (default)
     - terraform apply
     - Terraform creates the public Cloud DNS zone and the site verification TXT record.
     - It also outputs dns_nameservers for the zone.
  2) Update registrar nameservers
     - At your domain registrar, set the domain’s nameservers to the Terraform output value of dns_nameservers.
     - To print them: terraform output dns_nameservers
  3) Wait for DNS propagation (commonly 5–30+ minutes)
  4) Claim ownership
     - Re-run apply with the flag enabled:
       - terraform apply -var enable_site_verification=true
  5) Domain mappings (optional)
     - After ownership is verified and your Cloud Run services exist, enable mappings by setting cloud_run_services_exist = true (recommended via a local, gitignored infra/dev.local.auto.tfvars) and terraform apply.
- If verification fails with permission errors
  - Ensure ADC includes the Site Verification scope:
    - gcloud auth application-default login --scopes=https://www.googleapis.com/auth/siteverification

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
