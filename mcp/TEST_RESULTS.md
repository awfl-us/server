# MCP verification record

## Historical initial implementation (November 5, 2026)

Initial server PRs #10–#12 and CLI PRs #1–#2 passed five Node
protocol/security tests and six Python execution tests locally.
However, the first three merged server deployments failed during the newly
introduced pre-deployment Kubernetes/Firestore configuration step:

- https://github.com/awfl-us/server/actions/runs/42160965943
  — Firestore `PERMISSION_DENIED` for the GitHub deployer.
- https://github.com/awfl-us/server/actions/runs/42161255939
  — missing `container.clusters.get` permission.
- https://github.com/awfl-us/server/actions/runs/42161596215
  — missing `container.clusters.get` permission again.

The new API image was not deployed by those runs, so the live `/mcp`
endpoint, actual commands, Chromium/TintWiz and ChatGPT plugin were
not verified.

## Cleanup refactor

The new MCP-specific GKE wrapper, namespace, permissions, container image
and administrator bootstrap script have been removed. MCP now reuses the
existing AWFL GKE launcher and Python consumer image. Firebase and GitHub
tokens are forwarded exactly as for existing cloud consumers. The separate
MCP callback capability is *not* exported to shell subprocesses.

The existing merge-to-main workflow builds and deploys the API and consumer
without asking the GitHub deployment identity to configure new GKE IAM or
query Firestore directly. A deployment check verifies that `/mcp` returns
401 for anonymous requests rather than 404.

The original local unit test results are historical, not evidence that the
refactored deployment works. Verify the new GitHub Actions tests and
post-merge deployment run. Afterward, use the manually invoked
`scripts/mcp-smoke.js` under an authorized administrator identity for
real authenticated GKE execution, command polling and cancellation,
Chromium/TintWiz, and cleanup.

Phase 2 (the private ChatGPT Site and plugin) remains separate and must
not be reported as complete without an actual end-to-end test.
