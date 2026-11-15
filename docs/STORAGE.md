Storage and Persistence (Shared GCS bucket)

**Scope:** This document describes shared **object/filesystem storage in GCS**, not AWFL's document database. PostgreSQL on Cloud SQL `db-f1-micro` is now the [selected document database](postgres-storage-migration-plan.md); see the [platform-agnostic Storage interface plan](platform-agnostic-storage-implementation-plan.md). The running app has not yet switched from Firestore.

Overview
- Both the SSE consumer and the producer can persist per-project/workspace files under a shared Cloud Storage bucket mounted at WORK_ROOT (default /mnt/work).
- Paths are derived from WORK_PREFIX_TEMPLATE (default {projectId}/{workspaceId}). Services create and use subdirectories within the mount; absolute paths and parent traversal are rejected.

Infra
- Terraform: infra/storage.tf provisions a uniform-access GCS bucket with a 30-day delete lifecycle and outputs gcs_bucket_name.

Environment variables
- WORK_ROOT: path where the bucket (or local dir) is mounted; default /mnt/work.
- WORK_PREFIX_TEMPLATE: template to derive subdirectories; tokens: {projectId} {workspaceId} {sessionId} {userId}.
- GCS_BUCKET and ENABLE_GCS_FUSE: documented for reference; when using Cloud Run volumes, you do not need ENABLE_GCS_FUSE.

Cloud Run mounting (recommended)
- Deploy service normally, then attach the bucket as a volume mounted at /mnt/work.

Consumer example:
  gcloud run deploy sse-consumer \
    --image gcr.io/$PROJECT_ID/sse-consumer:TAG \
    --region $REGION \
    --no-allow-unauthenticated \
    --concurrency 10 \
    --timeout 3600 \
    --service-account $SERVICE_ACCOUNT_EMAIL \
    --set-env-vars WORK_ROOT=/mnt/work,WORK_PREFIX_TEMPLATE="{projectId}/{workspaceId}",WORKFLOWS_BASE_URL=$WORKFLOWS_BASE_URL,WORKFLOWS_AUDIENCE=$WORKFLOWS_AUDIENCE

  gcloud run services update sse-consumer \
    --region $REGION \
    --add-volume name=work,type=cloud-storage,bucket=$WORK_BUCKET \
    --add-volume-mount volume=work,mount-path=/mnt/work

Producer example:
  gcloud run deploy producer \
    --image gcr.io/$PROJECT_ID/producer:TAG \
    --region $REGION \
    --no-allow-unauthenticated \
    --concurrency 1 \
    --timeout 3600 \
    --service-account $SERVICE_ACCOUNT_EMAIL \
    --set-env-vars WORK_ROOT=/mnt/work,WORK_PREFIX_TEMPLATE="{projectId}/{workspaceId}",WORKFLOWS_BASE_URL=$WORKFLOWS_BASE_URL,WORKFLOWS_AUDIENCE=$WORKFLOWS_AUDIENCE,CONSUMER_BASE_URL=$CONSUMER_BASE_URL

  gcloud run services update producer \
    --region $REGION \
    --add-volume name=work,type=cloud-storage,bucket=$WORK_BUCKET \
    --add-volume-mount volume=work,mount-path=/mnt/work

IAM and isolation
- Grant storage.objectAdmin to the runtime service account on the bucket.
- Optionally restrict access to per-project prefixes using IAM Conditions, e.g. resource.name.startsWith("projects/_/buckets/$WORK_BUCKET/objects/${PROJECT_ID}/").

Local development (no bucket)
- Consumer: use scripts/dev.sh which bind-mounts ./_localwork to /mnt/work.
- Producer: run with a local bind mount similarly:
  docker run --rm -it \
    --env-file cloud/producer/.env.example \
    -e WORK_ROOT=/mnt/work \
    -v "$PWD/_localwork:/mnt/work" \
    -w /app -v "$PWD:/app" node:22 \
    node cloud/producer/app/runner.js

Smoke test steps (local)
1) Start the consumer locally (scripts/dev.sh) or via docker run with a bind mount.
2) Start a mock workflows service that emits a single tool_call event (or point to an existing one) and run the producer with CONSUMER_BASE_URL pointing at the consumer.
3) Verify the consumer logs show ensureWorkRoot creating /mnt/work/<projectId>/<workspaceId> and that tool operations are confined to this directory.
4) Inspect ./_localwork to confirm files are created under the expected prefix.

Notes
- Do not set ENABLE_GCS_FUSE when using Cloud Run volumes; it is only relevant if you run gcsfuse manually inside the container.
- Both services continue to operate without persistence if /mnt/work is not writable (producer logs a warning; consumer rejects file tool calls without a working directory).