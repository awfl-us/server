#!/usr/bin/env bash
set -euo pipefail

IMAGE="sse-consumer:dev"
WORK_ROOT_HOST_DIR="$(pwd)/_localwork"
PORT="8080"

mkdir -p "$WORK_ROOT_HOST_DIR"

# Build image
DOCKER_BUILDKIT=1 docker build -t "$IMAGE" cloud/sse-consumer

# Run container
exec docker run --rm -it \
  -p ${PORT}:8080 \
  -e SERVICE_AUTH_TOKEN=${SERVICE_AUTH_TOKEN:-devtoken} \
  -e DISABLE_GCSFUSE=1 \
  -e WORK_ROOT=/mnt/work \
  -e WORKFLOWS_BASE_URL=${WORKFLOWS_BASE_URL:-http://host.docker.internal:3000} \
  -e WORKFLOWS_AUDIENCE=${WORKFLOWS_AUDIENCE:-http://host.docker.internal:3000} \
  -v "${WORK_ROOT_HOST_DIR}:/mnt/work" \
  "$IMAGE"