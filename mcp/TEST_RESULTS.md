# Execution MCP verification record

Recorded November 5, 2026 (America/New_York).

## Passed locally

- `node --test mcp/tests/*.test.js`: 5 tests passed. Real MCP SDK client initialization,
  discovery, schema validation, invocation, authentication rejection; user ownership;
  API-key expiry/revocation semantics; GKE container restrictions; workspace capability
  mismatch/stop/expiry rejection.
- `python -m unittest discover -s tests -v` in awfl-us/cli: 6 tests passed. Real shell
  subprocesses, stdout/stderr and exit codes, polling, cancellation, workspace reuse,
  bounded reads, path traversal/symlink rejection, timeouts/output limits, concurrency,
  credential environment scrubbing, and a full `awfl run` subprocess consuming an
  authenticated SSE tool envelope and returning its authenticated HTTP callback.

## Actual deployment attempts

- Server PR #10 merged as `3fe0804ce8bf15e46fbf24c3304072c4abdfe043`.
- CLI PR #1 merged as `1ba827eb99075b107c6a9aafd91b85d04134a93e`.
- CLI PR #2 merged as `487604afbbbaadc3a76386de81630bfc0e7cc197`.
- Server PR #11 merged as `45981c97fd04c889c23970f0376714ab272c8def`.
- [Run 42160965943](https://github.com/awfl-us/server/actions/runs/42160965943):
  protocol tests passed and Google authentication succeeded; failed in private
  execution infrastructure setup. `scripts/mcp-owner.js` received Firestore
  `7 PERMISSION_DENIED: Missing or insufficient permissions` as the GitHub deployer.
  No new Cloud Run revision or execution workload was deployed by this attempt.
- [Run 42161255939](https://github.com/awfl-us/server/actions/runs/42161255939):
  five protocol/security tests passed; GKE setup failed with HTTP 403, missing
  `container.clusters.get` on `projects/awfl-us/locations/us-central1/clusters/awfl-gke`.
  This attempt also stopped before building/deploying a new revision.

## Not yet verified

The deployed `/mcp` endpoint, real GKE workspace creation, real authenticated command
execution, live output polling/cancellation, public HTTPS access from the workspace,
Chromium/TintWiz rendering, and deployed resource cleanup have **not** passed yet.
No private ChatGPT Site/plugin has been created or installed. Phase 2 remains gated
on successful Phase 1 live verification. Local tests do not establish cloud success.

## Next gate

A project/cluster administrator must run `scripts/bootstrap-mcp-access.sh` (or apply
the equivalent Terraform IAM bindings and namespace RBAC manifests). The available
GitHub deployment identity cannot grant itself missing permissions. After access is
configured, rerun deployment and inspect `mcp-smoke-results` for real acceptance
results before beginning the private Site integration.
