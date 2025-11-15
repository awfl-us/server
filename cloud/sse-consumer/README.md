SSE Consumer Service (Cloud Run)

Purpose
- Accept an authenticated, long-lived HTTP request that starts a lightweight project/session consumer
- The consumer connects to the internal workflows events stream and applies side effects on the mounted workspace
- Mount user-owned storage via Cloud Run Cloud Storage volume (or local bind mount) to persist project data
- Handle event tool calls (READ_FILE, UPDATE_FILE, RUN_COMMAND) directly in Node, then deliver results via the stored workflow callback
- Ensure data is synced on shutdown

Key change vs prior design
- We no longer install or spawn the awfl CLI. Instead, this service embeds a minimal Node-based consumer that:
  1) Opens an SSE connection to the workflows events stream for a workspace or project
  2) Parses JSON event payloads
  3) Executes supported tool calls against the mounted workspace
  4) Posts results to the internal callbacks endpoint using the provided callback_id

Directory
- cloud/sse-consumer/
  - app/server.js: Express app with /sessions/consume endpoint that starts the consumer
  - package.json: Node 22 runtime
  - Dockerfile: Minimal Node image; relies on Cloud Run Cloud Storage volume for mounting (no pipx, no awfl)

Runtime behavior
- Auth: Requires Authorization: Bearer <SERVICE_AUTH_TOKEN> unless SERVICE_AUTH_TOKEN is empty (dev only). In Cloud Run, prefer IAM between trusted services.
- Endpoint: GET /sessions/consume
  - query params:
    - userId (required)
    - projectId (required)
    - workspaceId (recommended) — preferred scoping for events stream
    - sessionId (optional, legacy)
    - bucket (optional, defaults to env GCS_BUCKET)
    - prefix (optional subdirectory inside the bucket)
    - since_id | since_time (optional) — initial replay cursor for events

- Consumer lifecycle:
  1) Verify caller auth and user context
  2) Ensure WORK_ROOT is available (Cloud Run volume mount or local bind mount)
  3) Connect to workflows/events/stream with the same user/project context
  4) For each SSE event with a JSON data payload, inspect data.tool_call.function.name and arguments
  5) Apply side effects in-process:
     - UPDATE_FILE: write file to mounted workspace
     - READ_FILE: read file content (UTF-8 with replacement), enforce max bytes
     - RUN_COMMAND: run shell command in workspace with timeout; capture stdout/stderr; truncate output
  6) If the event contains callback_id, POST the result payload to /workflows/callbacks/:id
  7) On client close or SIGTERM, stop the stream and flush any pending work

Event format (summary)
- The consumer expects SSE events where the data field is JSON with the shape used by the workflows service, including optional fields:
  - callback_id: string — required for sending results
  - create_time: ISO timestamp — echoed in results
  - tool_call: {
      function: { name: "UPDATE_FILE" | "READ_FILE" | "RUN_COMMAND", arguments: string | object }
    }
- Events without tool_call are ignored (no-op)

Side-effect handlers (Node)
- UPDATE_FILE
  - args: { filepath: string, content: string }
  - Behavior: ensure parent dir, write text to file
  - Callback payload: { filepath, sessionId, timestamp }

- READ_FILE
  - args: { filepath: string }
  - Behavior: read file as UTF-8 (with replacement), cap size by READ_FILE_MAX_BYTES
  - Callback payload: { sessionId, filepath, content, truncated, timestamp }

- RUN_COMMAND
  - args: { command: string }
  - Behavior: sanitize common artifacts, run with timeout (RUN_COMMAND_TIMEOUT_SECONDS), capture stdout/stderr; truncate output to OUTPUT_MAX_BYTES
  - Callback payload: { sessionId, command, output, error, timed_out?, timestamp }

Internal routing
- Events stream (reader): GET <WORKFLOWS_BASE_URL>/workflows/events/stream?workspaceId=...&since_id=...
  - Must present service-to-service identity (Cloud Run IAM) and the same user/project context used by your workflows service
- Callback delivery (writer): POST <WORKFLOWS_BASE_URL>/workflows/callbacks/:id
  - Forward minimal headers expected by the callbacks service (it derives auth and project scope from IAM and headers)
  - Include body with the result payload described above

Environment variables
- SERVICE_AUTH_TOKEN: bearer token expected by this service for inbound calls (use IAM in production)
- WORK_ROOT: mount point inside the container (default: /mnt/work)
- DISABLE_GCSFUSE: set to 1 when using Cloud Run Cloud Storage volume (recommended)
- GCS_BUCKET: default bucket if not provided via query (used for documentation/examples only)
- WORKFLOWS_BASE_URL: base URL for the internal workflows service (e.g., https://workflows-xyz-uc.run.app)
- WORKFLOWS_AUDIENCE: target audience for ID tokens when calling the workflows service (Cloud Run URL)
- EVENTS_HEARTBEAT_MS: keepalive for the upstream SSE connection (default: 15000)
- RECONNECT_BACKOFF_MS: initial backoff between SSE reconnects (default: 1000; exponential with cap)
- RUN_COMMAND_TIMEOUT_SECONDS: max seconds for shell commands (default: 120)
- READ_FILE_MAX_BYTES: cap returned read content size (default: 200000)
- OUTPUT_MAX_BYTES: cap command stdout returned in callbacks (default: 50000)

Authentication and user context
- Recommended: internal service-to-service calls only
  - This Cloud Run service is private (no-allow-unauthenticated)
  - Your trusted backend calls /sessions/consume with IAM or a pre-shared token, and passes userId, projectId, workspaceId
  - The consumer uses its own service account to call the workflows service (ID token audience = WORKFLOWS_AUDIENCE)
  - Optionally forward a signed user-context header (e.g., X-User-Context) if your workflows auth layer expects it

Storage mounting
- Recommended on Cloud Run: mount the Cloud Storage bucket at WORK_ROOT via Cloud Run Cloud Storage volumes; set DISABLE_GCSFUSE=1
- For local dev, bind mount a host directory to WORK_ROOT

Local dev
- Build: docker build -t sse-consumer:dev cloud/sse-consumer
- Run with a host directory as the work root:
  docker run --rm -it -p 8080:8080 \
    -e SERVICE_AUTH_TOKEN=devtoken \
    -e DISABLE_GCSFUSE=1 \
    -e WORK_ROOT=/mnt/work \
    -e WORKFLOWS_BASE_URL=http://host.docker.internal:3000 \
    -e WORKFLOWS_AUDIENCE=http://host.docker.internal:3000 \
    -v "$(pwd)/_localwork:/mnt/work" \
    sse-consumer:dev

- Start a consumer session:
  curl -N -H "Authorization: Bearer devtoken" \
    "http://localhost:8080/sessions/consume?userId=u1&projectId=p1&workspaceId=w1&since_time=2024-01-01T00:00:00Z"

Cloud Run deployment notes
- Deploy as a private service; call only from trusted backends
- Mount the Cloud Storage bucket at /mnt/work using Cloud Run volumes
  Example gcloud (verify flags for your gcloud version):
  gcloud run deploy $SERVICE \
    --image REGION-docker.pkg.dev/PROJECT/app/sse-consumer:TAG \
    --no-allow-unauthenticated \
    --service-account $RUNTIME_SA \
    --set-env-vars "DISABLE_GCSFUSE=1,WORK_ROOT=/mnt/work,WORKFLOWS_BASE_URL=$WORKFLOWS_URL,WORKFLOWS_AUDIENCE=$WORKFLOWS_URL" \
    --mount type=cloud-storage,source=$BUCKET,target=/mnt/work

Security
- Keep this service private and small in scope; it should only:
  - connect to the internal events stream,
  - apply file/command side effects within the mounted workspace,
  - and call the internal callbacks endpoint
- Avoid passing sensitive data in query strings; prefer signed user-context headers if needed
- Never store refresh tokens; rely on service-to-service IAM

Notes
- See workflows/events/index.js for the SSE stream contract and cursor parameters
- See workflows/callbacks/index.js for the callback invocation contract
- The consumer should implement an idle watchdog and exponential backoff reconnect like the Python reference to handle transient errors
