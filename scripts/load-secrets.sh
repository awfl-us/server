#!/bin/bash

SECRETS_FILE=${1:-secrets.txt}

echo "🔐 Loading secrets from Secret Manager..."
while IFS= read -r name || [[ -n "$name" ]]; do
  value=$(gcloud secrets versions access latest --secret="$name" 2>/dev/null)
  export "$name=$value"
done < "/app/$SECRETS_FILE"
