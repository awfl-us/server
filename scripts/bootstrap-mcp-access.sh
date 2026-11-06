#!/usr/bin/env bash
# Run once as the project/cluster administrator, from the server checkout.
# Grants deployment access only. Does not read or request an AWFL API key.
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT=awfl-us
DEPLOYER=github-deployer@awfl-us.iam.gserviceaccount.com
RUNTIME=323709301334-compute@developer.gserviceaccount.com
# These bindings are also declared in infra/mcp_execution.tf.
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$DEPLOYER" --role=roles/datastore.user --condition=None --quiet
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$DEPLOYER" --role=roles/container.clusterViewer --condition=None --quiet
gcloud container clusters get-credentials awfl-gke --region=us-central1 --project="$PROJECT"
sed "s|__RUNTIME_SA__|$RUNTIME|g" cloud/execution/policy.yaml | kubectl apply -f -
kubectl apply -f cloud/execution/deployer-rbac.yaml
printf '%s\n' 'Bootstrap complete. Re-run the latest Deploy to Cloud Run on Merge workflow.'
