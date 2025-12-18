Producer / Stream Manager (Cloud Run)

Overview
- Bridges the workflows event stream to the Consumer via Pub/Sub (no HTTP sidecar).
- For each incoming event with a tool_call, publishes a request message to the shared topic (channel=req) and waits for the Consumer reply (channel=resp).
- Posts callbacks to the workflows service when applicable and only then advances the replay cursor (no commit-on-publish).
- Supports a project/workspace-scoped working directory via WORK_ROOT + WORK_PREFIX_TEMPLATE. Persistence is optional; if no mount exists, it continues without writing.

Directory
- cloud/producer/
  - app/runner.js: main loop that subscribes to workflows events and handles Pub/Sub request/response + cursor commit
  - app/storage.js: minimal storage helper to ensure a project/workspace-scoped work root (safe path resolution)
  - app/gcs-downscope.js: helper to mint downscoped GCS tokens using Credential Access Boundaries (CAB)
  - .env.example: example configuration

Key environment variables
- WORKFLOWS_BASE_URL: base URL of the workflows service to subscribe to (required)
- WORKFLOWS_AUDIENCE: ID token audience for workflows (optional; defaults to WORKFLOWS_BASE_URL)
- PUBSUB_ENABLE: set to 1 to enable Pub/Sub transport (current default)
- TOPIC: shared Pub/Sub topic name (required when PUBSUB_ENABLE=1)
- SUBSCRIPTION: per-run reply subscription name (channel=resp) (required)
- ENC_KEY_B64: base64 256-bit key for AES-256-GCM envelope (required)
- X_USER_ID, X_PROJECT_ID: required context for events (routing)
- X_WORKSPACE_ID, X_SESSION_ID: optional context
- SINCE_ID, SINCE_TIME: optional replay position
- EVENTS_HEARTBEAT_MS, RECONNECT_BACKOFF_MS: tuning
- Storage-related (optional):
  - WORK_ROOT: mount point for storage (default /mnt/work)
  - WORK_PREFIX_TEMPLATE: default {projectId}/{workspaceId}
  - GCS_BUCKET, ENABLE_GCS_FUSE: provided for parity with the consumer docs; when using Cloud Run volumes you do not need to set ENABLE_GCS_FUSE.

Local development
- Example .env: copy .env.example and adjust URLs for your environment.
- Run (node):
  node cloud/producer/app/runner.js
- Optional bind mount for local persistence (from repo root):
  docker run --rm -it \
    --env-file cloud/producer/.env.example \
    -v "$PWD/_localwork:/mnt/work" \
    -w /app -v "$PWD:/app" node:22 \
    node cloud/producer/app/runner.js

Cloud Run deployment
- Deploy private and use IAM for inbound auth to the workflows service.
- Example deploy (image and variables adapted to your setup):
  gcloud run deploy producer \
    --image gcr.io/$PROJECT_ID/producer:latest \
    --region $REGION \
    --no-allow-unauthenticated \
    --timeout 3600 \
    --concurrency 1 \
    --service-account $SERVICE_ACCOUNT_EMAIL \
    --set-env-vars WORK_ROOT=/mnt/work,WORK_PREFIX_TEMPLATE="{projectId}/{workspaceId}",WORKFLOWS_BASE_URL=$WORKFLOWS_BASE_URL,WORKFLOWS_AUDIENCE=$WORKFLOWS_AUDIENCE,PUBSUB_ENABLE=1

- Mount Cloud Storage at /mnt/work if you want persistence (Cloud Run volumes):
  gcloud run services update producer \
    --region $REGION \
    --add-volume name=work,type=cloud-storage,bucket=$WORK_BUCKET \
    --add-volume-mount volume=work,mount-path=/mnt/work

Notes on Cloud Storage mounts
- The bucket root becomes WORK_ROOT. The producer and consumer both create per-request directories under this root using WORK_PREFIX_TEMPLATE.
- Recommended IAM: grant storage.objectAdmin to the runtime service account on the bucket; optionally restrict to per-project prefixes using IAM Conditions.
- You do not need to set ENABLE_GCS_FUSE when using Cloud Run volumes. ENABLE_GCS_FUSE is only relevant if you manually run gcsfuse in your container.

Security notes
- Keep the service private; only trusted backends should call it.
- The producer calls the workflows callbacks with an ID token; configure WORKFLOWS_AUDIENCE and service account correctly.

GCS downscoped tokens (Credential Access Boundary)
- Purpose: The producer can mint a per-tenant downscoped token and send it to the consumer via Pub/Sub payload, allowing list/get only within an allowed bucket/prefix.
- Default mode: explicit permissions. The token’s availablePermissions are [storage.objects.get, storage.objects.list]. No env var is required for this default.
- Role mode (optional): set GCS_CAB_PERMISSION_MODE=role to use [inRole:roles/storage.objectViewer] in the CAB.
- Prefix normalization: the CAB condition uses a normalized prefix that always ends with a trailing slash.
- Debugging: set GCS_DEBUG=1 to log CAB details and redacted token-mint debug.

Troubleshooting GCS 403
- Verify IAM on the bucket for the source principal (producer’s service account): at minimum roles/storage.objectViewer when minting a read-only downscoped token.
- Confirm the prefix is correct and normalized.
- Use the testPermissions endpoint with the downscoped token to confirm storage.objects.list is present:
  GET https://www.googleapis.com/storage/v1/b/<BUCKET>/iam/testPermissions?permissions=storage.objects.list
  Header: Authorization: Bearer <DOWNSCOPED_TOKEN>

Troubleshooting
- 403 on bucket access: ensure the service account has storage.objectAdmin on the bucket and that the volume is mounted at /mnt/work.
- Connection issues to workflows: verify URLs, audiences, and IAM settings.
- NOT_FOUND on Pub/Sub topic/subscription: ensure you created them in the same GCP project the container uses (GOOGLE_CLOUD_PROJECT). Pass --project "$PROJECT_ID" to gcloud commands and prefer a fully-qualified topic in subscription creation, e.g., --topic "projects/$PROJECT_ID/topics/$TOPIC".

Run locally with Docker Desktop (build image and run)
- This runs the Producer using a locally built image. Use production Pub/Sub (no emulator).
- Place serviceAccountKey.json at the repo root (gitignored) and run commands from the repo root so $PWD resolves correctly.

1) Build the image

```
docker build -t awfl-producer:dev cloud/producer
```

2) Prepare env and Pub/Sub resources (use `setopt INTERACTIVE_COMMENTS` in zsh)

```
export PROJECT_ID="awfl-us"
export TOPIC="awfl-events"
export SUB_RESP="producer-replies-$(date '+%s')"
export USER_ID="u_demo"
export PROJECT_CTX="p_demo"              # project id used for routing (not GCP project)
export ENC_KEY_B64="$(openssl rand -base64 32)"
export WORKFLOWS_BASE_URL="http://host.docker.internal:5050/jobs"  # if workflows runs on your host

(gcloud pubsub topics describe "$TOPIC" --project "$PROJECT_ID" >/dev/null 2>&1) || \
  gcloud pubsub topics create "$TOPIC" --project "$PROJECT_ID"

gcloud pubsub subscriptions create "$SUB_RESP" \
  --project "$PROJECT_ID" \
  --topic "projects/$PROJECT_ID/topics/$TOPIC" \
  --ack-deadline 20 \
  --message-retention-duration 3600s || true

# Optional: sanity check
#gcloud pubsub subscriptions describe "$SUB_RESP" --project "$PROJECT_ID"
```

3) Run the container

```
docker run --rm -it \
  -e NODE_ENV=production \
  -e PUBSUB_ENABLE=1 \
  -e GOOGLE_CLOUD_PROJECT="$PROJECT_ID" \
  -e TOPIC="$TOPIC" \
  -e SUBSCRIPTION="$SUB_RESP" \
  -e ENC_KEY_B64="$ENC_KEY_B64" \
  -e X_USER_ID="$USER_ID" \
  -e X_PROJECT_ID="$PROJECT_CTX" \
  -e WORKFLOWS_BASE_URL="$WORKFLOWS_BASE_URL" \
  -e WORKFLOWS_AUDIENCE="$WORKFLOWS_BASE_URL" \
  -e GOOGLE_APPLICATION_CREDENTIALS="/var/secrets/google/key.json" \
  -v "$PWD/serviceAccountKey.json:/var/secrets/google/key.json:ro" \
  awfl-producer:dev
```

Docker Compose (optional)
- docker-compose.yml example for the Producer (run from repo root):

```
services:
  producer:
    image: awfl/producer:dev
    environment:
      NODE_ENV: production
      PUBSUB_ENABLE: "1"
      GOOGLE_CLOUD_PROJECT: ${PROJECT_ID}
      TOPIC: ${TOPIC}
      SUBSCRIPTION: ${SUB_RESP}
      ENC_KEY_B64: ${ENC_KEY_B64}
      X_USER_ID: ${USER_ID}
      X_PROJECT_ID: ${PROJECT_CTX}
      WORKFLOWS_BASE_URL: ${WORKFLOWS_BASE_URL}
      WORKFLOWS_AUDIENCE: ${WORKFLOWS_BASE_URL}
      GOOGLE_APPLICATION_CREDENTIALS: /var/secrets/google/key.json
    volumes:
      - ./serviceAccountKey.json:/var/secrets/google/key.json:ro
```

Then:

```
docker compose up --build producer
```

Notes
- Use host.docker.internal in WORKFLOWS_BASE_URL to reach a service on your host from inside the container (Docker Desktop).
- Keep GOOGLE_APPLICATION_CREDENTIALS set to the in-container path (/var/secrets/google/key.json); mount the host key via a relative path (./serviceAccountKey.json).
- The Producer will publish requests to $TOPIC (channel=req) and listen for replies on $SUB_RESP (channel=resp). The Consumer must be running separately and subscribed to channel=req, or use the orchestrator to launch both Jobs.

Quick test: start the Producer via the Jobs API (orchestrator)
- The awfl-server exposes a POST /jobs/producer/start endpoint that wires per-run Pub/Sub subscriptions and launches the Cloud Run Jobs for the Producer and Consumer.
- Set your API base URL and context headers, then call start. Replace values as needed.

```
export API_BASE="http://localhost:3000"   # awfl-server base URL
export USER_ID="u_demo"
export PROJECT_ID="p_demo"

curl -sS -X POST "$API_BASE/jobs/producer/start" \
  -H "Content-Type: application/json" \
  -H "x-user-id: $USER_ID" \
  -H "x-project-id: $PROJECT_ID" \
  --data '{
    "eventsHeartbeatMs": 15000
  }'
```

- Expected: HTTP 202 with JSON including fields like enc_fp, sub_req, sub_resp, topic, operation, etc.
- To stop and clean up (best-effort):

```
curl -sS -X POST "$API_BASE/jobs/producer/stop" \
  -H "x-user-id: $USER_ID" \
  -H "x-project-id: $PROJECT_ID"
```

Notes
- The server must be configured with: PUBSUB_TOPIC, PRODUCER_CLOUD_RUN_JOB_NAME, CONSUMER_CLOUD_RUN_JOB_NAME, and a GCP project/region.
- In secured environments, add your Authorization header as required by awfl-server; the x-user-id/x-project-id headers are used to scope routing and locks in dev.
