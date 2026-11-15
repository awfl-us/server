#!/usr/bin/env bash
set -euo pipefail
url="${1:?databaseURL required}"
file="${2:?rules JSON required}"
token="$(gcloud auth print-access-token)"
# Admin IAM tokens bypass rules. A default-deny policy blocks client SDK access.
curl --fail-with-body --retry 4 --retry-delay 1 --silent --show-error \
  -X PUT -H "Authorization: Bearer ${token}" \
  -H 'Content-Type: application/json' \
  --data-binary "@${file}" "${url%/}/.settings/rules.json" >/dev/null
echo 'RTDB client security rules applied (deny all)'
