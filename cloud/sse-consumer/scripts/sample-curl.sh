#!/usr/bin/env bash
set -euo pipefail

TOKEN=${SERVICE_AUTH_TOKEN:-devtoken}
BASE_URL=${BASE_URL:-http://localhost:8080}
USER_ID=${USER_ID:-u1}
PROJECT_ID=${PROJECT_ID:-p1}
WORKSPACE_ID=${WORKSPACE_ID:-w1}
SINCE_TIME=${SINCE_TIME:-2024-01-01T00:00:00Z}

exec curl -N -H "Authorization: Bearer ${TOKEN}" \
  "${BASE_URL}/sessions/consume?userId=${USER_ID}&projectId=${PROJECT_ID}&workspaceId=${WORKSPACE_ID}&since_time=${SINCE_TIME}"