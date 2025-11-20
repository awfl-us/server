Producer / Stream Manager (Cloud Run)

Overview
- Bridges the workflows event stream to the SSE consumer.
- For each incoming event with a tool_call, forwards it to the consumer’s POST /sessions/stream and optionally posts a callback back to the workflows service.
- Maintains a replay cursor (event id or time).
- Supports a project/workspace-scoped working directory via WORK_ROOT + WORK_PREFIX_TEMPLATE. Persistence is optional; if no mount exists, it continues without writing.

Directory
- cloud/producer/
  - app/runner.js: main loop that subscribes to workflows events and forwards tool calls to the consumer
  - app/storage.js: minimal storage helper to ensure a project/workspace-scoped work root (safe path resolution)
  - app/gcs-downscope.js: helper to mint downscoped GCS tokens using Credential Access Boundaries (CAB)
  - .env.example: example configuration

Key environment variables
- WORKFLOWS_BASE_URL: base URL of the workflows service to subscribe to (required)
- WORKFLOWS_AUDIENCE: ID token audience for workflows (optional; defaults to WORKFLOWS_BASE_URL)
- CONSUMER_BASE_URL: base URL of the consumer service (required)
- SERVICE_AUTH_TOKEN: optional dev bearer token for consumer (use IAM in Cloud Run)
- X_USER_ID, X_PROJECT_ID: required context for events
- X_WORKSPACE_ID, X_SESSION_ID: optional context
- SINCE_ID, SINCE_TIME: optional replay position
- EVENTS_HEARTBEAT_MS, RECONNECT_BACKOFF_MS: tuning
- Storage-related (optional):
  - WORK_ROOT: mount point for storage (default /mnt/work)
  - WORK_PREFIX_TEMPLATE: default {projectId}/{workspaceId}
  - GCS_BUCKET, ENABLE_GCS_FUSE: provided for parity with the consumer docs; when using Cloud Run volumes you do not need to set ENABLE_GCS_FUSE.

Local development
- Example .env: copy .env.example and adjust URLs for your environment.
- Run:
  node cloud/producer/app/runner.js
- Optional bind mount for local persistence (from repo root):
  docker run --rm -it \
    --env-file cloud/producer/.env.example \
    -v "$PWD/_localwork:/mnt/work" \
    -w /app -v "$PWD:/app" node:22 \
    node cloud/producer/app/runner.js

Cloud Run deployment
- Deploy private and use IAM for inbound auth to the consumer and workflows service.
- Example deploy (image and variables adapted to your setup):
  gcloud run deploy producer \
    --image gcr.io/$PROJECT_ID/producer:latest \
    --region $REGION \
    --no-allow-unauthenticated \
    --timeout 3600 \
    --concurrency 1 \
    --service-account $SERVICE_ACCOUNT_EMAIL \
    --set-env-vars WORK_ROOT=/mnt/work,WORK_PREFIX_TEMPLATE="{projectId}/{workspaceId}",WORKFLOWS_BASE_URL=$WORKFLOWS_BASE_URL,WORKFLOWS_AUDIENCE=$WORKFLOWS_AUDIENCE,CONSUMER_BASE_URL=$CONSUMER_BASE_URL

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
- Purpose: The producer can mint a per-tenant downscoped token and send it to the consumer (header X-Gcs-Token) so the consumer can list/get objects only within an allowed bucket/prefix.
- Default mode: explicit permissions. The token’s availablePermissions are [storage.objects.get, storage.objects.list]. No env var is required for this default.
- Role mode (optional): set GCS_CAB_PERMISSION_MODE=role to use [inRole:roles/storage.objectViewer] in the CAB.
- Prefix normalization: the CAB condition uses a normalized prefix that always ends with a trailing slash. Provide prefixes without worrying about the trailing slash; it will be enforced.
- Debugging: set GCS_DEBUG=1 to log CAB details, ctor variant used for DownscopedClient, and token-mint debug (token preview redacted).

Troubleshooting GCS 403
- Verify IAM on the bucket for the source principal (producer’s service account): at minimum roles/storage.objectViewer when minting a read-only downscoped token.
- Confirm the prefix is correct and normalized. A mismatch will cause 403 for list/get outside the allowed boundary.
- Use the testPermissions endpoint with the downscoped token to confirm storage.objects.list is present:
  GET https://www.googleapis.com/storage/v1/b/<BUCKET>/iam/testPermissions?permissions=storage.objects.list
  Header: Authorization: Bearer <DOWNSCOPED_TOKEN>
- Enable GCS_DEBUG=1 to see request/response details from the consumer and CAB build details from the producer.

Troubleshooting
- 403 on bucket access: ensure the service account has storage.objectAdmin on the bucket and that the volume is mounted at /mnt/work.
- Connection issues to consumer or workflows: verify URLs, audiences, and IAM settings.
