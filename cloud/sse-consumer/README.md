SSE Consumer Service (Cloud Run)

Overview
- Node-only service that executes tool calls (READ_FILE, UPDATE_FILE, RUN_COMMAND) against a sandboxed work directory (WORK_ROOT).
- Two modes of operation:
  1) Pull + callbacks (GET /sessions/consume): the consumer connects outbound to the workflows SSE stream and posts results to callbacks.
  2) Push, stateless streaming (POST /sessions/stream): your backend connects to the consumer, streams NDJSON events in, and receives NDJSON results on the same response. No outbound calls from the consumer.

Key properties
- Sandboxed storage: all file ops occur under a per-request working directory rooted at WORK_ROOT; path traversal is prevented.
- Project/workspace scoping: the working directory is derived from WORK_PREFIX_TEMPLATE using request context (project/workspace/user/session).
- Command safety: RUN_COMMAND executes in the working directory with timeout and output caps.
- Long-lived connections: heartbeats keep connections open; idle watchdog triggers reconnect (pull mode).

Directory
- cloud/sse-consumer/
  - app/server.js: Express app, tool handlers, SSE client, and endpoints
  - app/storage.js: storage helpers (safe path resolution, work root creation)
  - Dockerfile: Node 22 slim
  - scripts/dev.sh: build and run locally with bind mount at /mnt/work
  - scripts/sample-curl.sh: sample pull-mode session starter

Endpoints

1) GET /sessions/consume (pull + callbacks)
- Starts a consumer that connects to WORKFLOWS_BASE_URL/workflows/events/stream and posts results to /workflows/callbacks/:id.
- Query params or headers for context:
  - userId (or header X-User-Id) — required
  - projectId (or header X-Project-Id) — required
  - workspaceId (or header X-Workspace-Id) — recommended
  - sessionId — optional (used for directory scoping if referenced by template)
  - since_id | since_time — optional replay cursor
- Behavior:
  - Parses SSE frames, executes supported tools, and for events with callback_id posts a result payload to callbacks.
  - Sends "ping" lines to the client to keep the response open.
  - Reconnects on upstream end/error/idle with exponential backoff; resumes via lastEventId.
- Auth inbound: SERVICE_AUTH_TOKEN (dev) or Cloud Run IAM (recommended).
- Auth outbound: ID token for WORKFLOWS_AUDIENCE when posting callbacks; falls back to no Authorization in local dev.

2) POST /sessions/stream (push, stateless streaming)
- Your backend sends NDJSON events in the request body; the consumer writes NDJSON results back on the same connection.
- Context is set once via headers or query and applies to all events in the stream:
  - Required: X-User-Id or ?userId=, X-Project-Id or ?projectId=
  - Optional: X-Workspace-Id or ?workspaceId=, sessionId
- Content types:
  - Request: Content-Type: application/x-ndjson (one JSON event per line)
  - Response: application/x-ndjson (one JSON result per input line, plus heartbeat pings)
- Behavior:
  - Executes the tool_call in each input line and writes the result line immediately. No outbound callbacks.
  - Sends periodic {"type":"ping"} lines to keep the connection alive.
  - When GCS sync is configured, emits gcs_sync stats lines: { scannedRemote, downloaded, uploaded, conflicts }.
- Auth inbound: SERVICE_AUTH_TOKEN (dev) or Cloud Run IAM. No outbound auth needed.

Event schema (input)
- Same shape in both modes; for streaming mode, the event is one JSON object per line:
  {
    "id": "evt-1",
    "create_time": "2025-01-01T00:00:00Z",
    "callback_id": "cb-1" // optional; ignored in streaming mode
    "tool_call": {
      "function": {
        "name": "UPDATE_FILE" | "READ_FILE" | "RUN_COMMAND",
        "arguments": { ... } | "{...}" // object or JSON string
      }
    }
  }

Result schema (output)
- For callbacks (pull mode) or direct output line (streaming mode):
  {
    "event_id": "evt-1",
    "create_time": "2025-01-01T00:00:00Z",
    "tool": { "name": "READ_FILE" },
    "args": { ... },
    "result": { ... },
    "error": { "message": "..." } | null,
    "timestamp": "2025-...Z"
  }

Supported tools
- UPDATE_FILE({ filepath, content })
  - Ensures parent dir; writes UTF-8 content.
  - Returns { ok: true, filepath, bytes, mtimeMs }.
- READ_FILE({ filepath })
  - Reads UTF-8, capped at READ_FILE_MAX_BYTES; sets truncated=true if capped.
  - Returns { ok: true, filepath, content, truncated }.
- RUN_COMMAND({ command })
  - Executes via bash -lc in the working directory with timeout RUN_COMMAND_TIMEOUT_SECONDS; caps output at OUTPUT_MAX_BYTES.
  - Returns { exitCode, output, error, timeoutMs }.

Storage and working directory
- Base mount: WORK_ROOT specifies the base mount path for sandboxed storage (default /mnt/work). For local dev, bind-mount a host folder to this path. In Cloud Run, mount a Cloud Storage bucket or other volume at this path (see below).
- Per-request work root: The consumer derives a directory under WORK_ROOT using WORK_PREFIX_TEMPLATE rendered with request context.
  - WORK_PREFIX_TEMPLATE default: {projectId}/{workspaceId}
  - Supported tokens: {projectId}, {workspaceId}, {sessionId}, {userId}
  - Example: WORK_PREFIX_TEMPLATE="{projectId}/{workspaceId}/{userId}" with projectId=p-1, workspaceId=w-2, userId=u-9 => /mnt/work/p-1/w-2/u-9
- Safety: All file paths used by tools must be relative; absolute paths and parent traversal are rejected. Paths are resolved and enforced to stay within the per-request working directory.

GCS sync (download + upload)
- When provided a GCS bucket/prefix and a downscoped token via X-Gcs-Token, the consumer mirrors objects under that prefix into the per-request work root and can push local changes back to GCS.
- Uploads are enabled by default (GCS_ENABLE_UPLOAD=1). Set to 0 to disable uploads.
- Change detection is manifest-based: a .gcs-manifest.json file in the work root tracks each object’s remote generation, local size, and mtime.
- Conflict protection: uploads use conditional ifGenerationMatch to avoid overwriting remote changes.
  - ifGenerationMatch=prev.remoteGen when replacing an existing object.
  - ifGenerationMatch=0 when creating a new object.
- Sync lifecycle: initial sync on stream start (if SYNC_ON_START=1), periodic sync while the stream is open, and a final sync on shutdown.
- The streaming endpoint emits gcs_sync stats lines: { scannedRemote, downloaded, uploaded, conflicts }.

Environment variables
- SERVICE_AUTH_TOKEN: inbound bearer token (dev only). If unset, auth is skipped locally; prefer IAM in Cloud Run.
- WORK_ROOT: directory mount point (default /mnt/work).
- WORK_PREFIX_TEMPLATE: template for deriving per-request directory (default {projectId}/{workspaceId}).
- WORKFLOWS_BASE_URL: base URL for workflows service (pull mode only).
- WORKFLOWS_AUDIENCE: ID token audience for workflows service (pull mode only).
- EVENTS_HEARTBEAT_MS: keepalive ping interval (default 15000).
- RECONNECT_BACKOFF_MS: initial reconnect delay for pull mode (default 1000; exponential with cap 30000).
- RUN_COMMAND_TIMEOUT_SECONDS: command timeout (default 120).
- READ_FILE_MAX_BYTES: max bytes returned by READ_FILE (default 200000).
- OUTPUT_MAX_BYTES: max combined stdout/stderr captured by RUN_COMMAND (default 50000).
- GCS_BUCKET: Cloud Storage bucket used for sync (when present and token provided).
- GCS_PREFIX_TEMPLATE: object prefix template for sync (supports {projectId},{workspaceId},{sessionId},{userId}).
- GCS_ENABLE_UPLOAD: enable consumer uploads to GCS (default 1).
- GCS_UPLOAD_CONCURRENCY: parallel uploads (default 4).
- SYNC_ON_START: run an initial sync on stream start (default 1).
- SYNC_INTERVAL_MS: periodic sync interval in milliseconds (default 15000).
- GCS_DEBUG: set to 1 to enable verbose sync and permission diagnostics.

Cloud Run deployment notes
- Deploy private; use IAM for inbound auth. Example flags (adjust for your environment):
  gcloud run deploy sse-consumer \
    --image gcr.io/$PROJECT_ID/sse-consumer:latest \
    --region $REGION \
    --no-allow-unauthenticated \
    --timeout 3600 \
    --concurrency 1 \
    --service-account $SERVICE_ACCOUNT_EMAIL \
    --set-env-vars WORK_ROOT=/mnt/work,WORK_PREFIX_TEMPLATE="{projectId}/{workspaceId}",WORKFLOWS_BASE_URL=$WORKFLOWS_BASE_URL,WORKFLOWS_AUDIENCE=$WORKFLOWS_AUDIENCE

- Mount Cloud Storage at /mnt/work if you need persistence (Cloud Run volumes):
  gcloud run services update sse-consumer \
    --region $REGION \
    --add-volume name=work,type=cloud-storage,bucket=$WORK_BUCKET \
    --add-volume-mount volume=work,mount-path=/mnt/work

Notes on Cloud Storage mounts
- The bucket root becomes WORK_ROOT; the per-request work directories are created under that root using the template. For example, if WORK_BUCKET is gs://my-work and template is {projectId}/{workspaceId}, files will be under gs://my-work/p-1/w-2/...
- Ensure the service account has storage.objectAdmin on the bucket.

Local development
- Build and run (bind-mount _localwork to /mnt/work):
  ./cloud/sse-consumer/scripts/dev.sh

- Pull mode example:
  ./cloud/sse-consumer/scripts/sample-curl.sh

- Streaming mode example:
  curl -N -sS \
    -H "Content-Type: application/x-ndjson" \
    -H "X-User-Id: u-123" \
    -H "X-Project-Id: p-123" \
    -H "X-Workspace-Id: w-123" \
    --data-binary @- \
    http://localhost:8080/sessions/stream <<'EOF'
  {"id":"evt-1","tool_call":{"function":{"name":"UPDATE_FILE","arguments":{"filepath":"notes/hello.txt","content":"Hello"}}}}
  {"id":"evt-2","tool_call":{"function":{"name":"READ_FILE","arguments":{"filepath":"notes/hello.txt"}}}}
  {"id":"evt-3","tool_call":{"function":{"name":"RUN_COMMAND","arguments":{"command":"ls -la"}}}}
  EOF

Run with Docker (manual, to view logs in your terminal)
- If you prefer to run without the helper script and keep the container attached so logs are visible:

1) Build the image

```
docker build -t sse-consumer:dev cloud/sse-consumer
```

2) Run the container

```
docker run --rm -it \
  -p 8080:8080 \
  -e SERVICE_AUTH_TOKEN=devtoken \
  -e WORK_ROOT=/mnt/work \
  -e WORKFLOWS_BASE_URL="http://host.docker.internal:3000" \
  -e WORKFLOWS_AUDIENCE="http://host.docker.internal:3000" \
  -v "$PWD/_localwork:/mnt/work" \
  sse-consumer:dev
```

Notes
- Use host.docker.internal to reach services running on your host (Docker Desktop).
- To preserve logs after the container exits, drop --rm and add a name, then tail logs:
  - docker run --name sse-consumer-debug -it ... sse-consumer:dev
  - docker logs -f sse-consumer-debug
- The service listens on port 8080 by default; the example maps it to localhost:8080.

Run the Pub/Sub Consumer locally (for debugging the Producer in terminal)
- The Pub/Sub Consumer is a separate image (cloud/consumer). Use this when pairing with the Producer over Pub/Sub and you want terminal logs.

A) Build the consumer image

```
docker build -t awfl-consumer:dev cloud/consumer
```

B) Prepare env and Pub/Sub resources (mirrors the Producer example)

```
# Required for the consumer: TOPIC, SUBSCRIPTION, ENC_KEY_B64
export PROJECT_ID="awfl-us"
export TOPIC="awfl-events"
export SUB_REQ="producer-requests-$(date '+%s')"  # subscription for channel=req
export ENC_KEY_B64="$(openssl rand -base64 32)"

# Ensure topic and subscription exist in the intended project
(gcloud pubsub topics describe "$TOPIC" --project "$PROJECT_ID" >/dev/null 2>&1) || \
  gcloud pubsub topics create "$TOPIC" --project "$PROJECT_ID"

gcloud pubsub subscriptions create "$SUB_REQ" \
  --project "$PROJECT_ID" \
  --topic "projects/$PROJECT_ID/topics/$TOPIC" \
  --ack-deadline 20 \
  --message-retention-duration 3600s || true

# Optional: sanity check
#gcloud pubsub subscriptions describe "$SUB_REQ" --project "$PROJECT_ID"
```

C) Run the consumer container (shows logs in your terminal)

```
docker run --rm -it \
  -e NODE_ENV=production \
  -e GOOGLE_CLOUD_PROJECT="$PROJECT_ID" \
  -e SUBSCRIPTION="$SUB_REQ" \
  -e TOPIC="$TOPIC" \
  -e ENC_KEY_B64="$ENC_KEY_B64" \
  -e REPLY_CHANNEL="resp" \
  -e GOOGLE_APPLICATION_CREDENTIALS="/var/secrets/google/key.json" \
  -v "$PWD/serviceAccountKey.json:/var/secrets/google/key.json:ro" \
  awfl-consumer:dev
```

Troubleshooting
- Error: "[consumer] missing required env: TOPIC,SUBSCRIPTION,ENC_KEY_B64"
  - Ensure you exported TOPIC, set SUB_REQ, and ENC_KEY_B64 as shown above, and that you pass them via -e in docker run.
- Error: "[consumer] subscription error Resource not found (resource=...)"
  - Likely cause: the subscription was created in a different GCP project than the one the container is using.
  - Fix: pass --project "$PROJECT_ID" to gcloud topic/subscription commands (or run gcloud config set project "$PROJECT_ID") and prefer fully-qualified topic when creating the subscription, e.g. --topic "projects/$PROJECT_ID/topics/$TOPIC".
- If the container exits immediately, drop --rm and add a name to inspect logs after exit:
  - docker run --name awfl-consumer-debug -it ... awfl-consumer:dev
  - docker logs -f awfl-consumer-debug

Security notes
- Keep the service private. Inbound calls from trusted backends only.
- In streaming mode, there are no outbound requests from the consumer.
- In pull mode, outbound requests are limited to callbacks to the workflows service using ID tokens.
