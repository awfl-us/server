#!/bin/bash

echo "🔐 Loading secrets from Secret Manager..."
for name in $(cat /app/functions/secrets.txt); do
  value=$(gcloud secrets versions access latest --secret="$name" 2>/dev/null)
  export "$name=$value"
done
