#!/usr/bin/env bash
# Correlate a root native execution across API, Jobs and nested in-process calls.
set -euo pipefail
EXECUTION_ID="${1:?Usage: native-trace-logs.sh native_<32hex> [gcp-project] [days]}"
PROJECT="${2:-awfl-us}"
DAYS="${3:-7}"
if [[ ! "$EXECUTION_ID" =~ ^native_[a-f0-9]{32}$ ]]; then
  echo 'Invalid native execution ID' >&2; exit 2
fi
if [[ ! "$DAYS" =~ ^[0-9]{1,3}$ ]]; then
  echo 'Invalid days parameter' >&2; exit 2
fi
START="$(date -u -d "${DAYS} days ago" +'%Y-%m-%dT%H:%M:%SZ')"
FILTER="timestamp>=\"${START}\" AND (jsonPayload.rootExecutionId=\"${EXECUTION_ID}\" OR jsonPayload.executionId=\"${EXECUTION_ID}\" OR textPayload:\"${EXECUTION_ID}\")"
GCLOUD_ARGS=()
TOKEN_FILE="${AWFL_GOOGLE_ACCESS_TOKEN_FILE:-/tmp/awfl-google-access-token}"
if [[ -s "$TOKEN_FILE" ]]; then GCLOUD_ARGS+=("--access-token-file=$TOKEN_FILE"); fi
gcloud "${GCLOUD_ARGS[@]}" logging read "$FILTER" --project "$PROJECT" --limit 300 \
  --order asc --format=json | python3 -c '
import json,sys
for e in json.load(sys.stdin):
 p=e.get("jsonPayload",{});s=e.get("textPayload","")
 if not p and s.startswith("{"):
  try:p=json.loads(s)
  except:pass
 if not isinstance(p,dict):p={}
 event=p.get("event","")
 origin=e.get("resource",{}).get("labels",{})
 identity=origin.get("service_name",origin.get("container_name",""))
 parts=[e.get("timestamp",""),e.get("severity",""),identity,event,
        p.get("workflow", ""),p.get("operation", ""),p.get("effectId", ""),
        p.get("executionId", ""),p.get("parentExecutionId", ""),
        str(p.get("durationMs", "")),p.get("errorMessage", "")]
 print(" | ".join(str(x).replace("\\n", " ")[:350] for x in parts if x))
 if not p and s:print("  "+s[:500].replace("\\n", " "))
'
