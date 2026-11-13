#!/usr/bin/env python3
"""Export one already-authorized native run as local replay data.

This reads existing Firestore effect journals using the GKE environment's
existing gcloud user token. It never submits or replays an HTTP request.
Output contains real user/project data: store OUTSIDE the Git working tree.
"""
import argparse
import json
import os
import re
from pathlib import Path

from google.cloud import firestore
from google.oauth2.credentials import Credentials

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execution", required=True)
    parser.add_argument("--out-prefix", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"native_[a-f0-9]{32}", args.execution):
        parser.error("invalid native execution ID")
    token_file = os.environ.get("CLOUDSDK_AUTH_ACCESS_TOKEN_FILE")
    user = os.environ.get("AWFL_USER_ID")
    project = os.environ.get("AWFL_PROJECT_ID")
    if not token_file or not user or not project:
        parser.error("requires authenticated AWFL GKE environment")
    out = Path(args.out_prefix).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    creds = Credentials(token=Path(token_file).read_text().strip())
    db = firestore.Client(project=os.environ.get("CLOUDSDK_CORE_PROJECT", "awfl-us"),
                          credentials=creds)
    collection = db.collection("nativeWorkflowExecutions")
    snap = collection.document(args.execution).get()
    if not snap.exists:
        raise RuntimeError("native execution not found")
    parent = snap.to_dict()
    if parent.get("userId") != user or parent.get("projectId") != project:
        raise RuntimeError("native execution does not belong to authenticated GKE owner")
    input_data = json.loads(parent["inputJson"])
    fixtures = {}
    duplicate = []
    def add_journal(ref):
        for journal in ref.collection("effects").stream():
            record = journal.to_dict()
            if record.get("isError") or not record.get("outcomeJson"):
                continue
            value = json.loads(record["outcomeJson"])
            if not isinstance(value, dict) or not isinstance(value.get("code"), int):
                continue
            prior = fixtures.get(journal.id)
            if prior is not None and prior != value:
                duplicate.append(journal.id)
            else:
                fixtures[journal.id] = value
    add_journal(snap.reference)
    for child in collection.order_by("createdAt",
            direction=firestore.Query.DESCENDING).limit(250).stream():
        record = child.to_dict()
        if args.execution in (record.get("forkLaneJson") or ""):
            if record.get("userId") != user or record.get("projectId") != project:
                raise RuntimeError("fork lane identity mismatch")
            add_journal(child.reference)
    if duplicate:
        raise RuntimeError("ambiguous repeated effect IDs across workflows: " +
                           ", ".join(sorted(set(duplicate))[:8]))
    for suffix, data in ((".input.json", input_data), (".http.json", fixtures)):
        path = Path(str(out) + suffix)
        if path.exists():
            raise RuntimeError("refusing to overwrite existing private fixture: " + str(path))
        path.write_text(json.dumps(data, indent=2) + "\n")
        path.chmod(0o600)
    print("EXPORTED_NATIVE_LOCAL_FIXTURES", args.execution,
          "httpEffects", len(fixtures), "files", str(out) + ".{input,http}.json")

if __name__ == "__main__":
    main()
