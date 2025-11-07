#!/usr/bin/env bash
set -euo pipefail

# Optionally load secrets if running locally with gcloud available
if [[ -f /app/secrets.txt ]] && command -v gcloud >/dev/null 2>&1; then
  echo "Loading secrets from /app/secrets.txt via Secret Manager"
  /app/load-secrets.sh /app/secrets.txt || true
fi

TARGET="${SERVICE_TARGET}"
echo "Starting service with target: ${TARGET}"
npm run "${TARGET}"