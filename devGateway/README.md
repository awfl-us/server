# AWFL workspace HTTP gateway (in progress)

Goal: reuse the already public **`api` Cloud Run service** for Google Workflows
development callbacks AND browser previews. The API verifies Workflow OIDC
against the full workspace-specific `BASE_URL` once, then proxies the request
to the project consumer pod. The pod does not reverify the token.
No additional workflows, workflow suffixes, public pod IPs, or per-workspace
load balancers are required.

Proposed URL (not deployed):

`https://<api-origin>/dev/{workspace-id}/{port}/{relative-path}` for Workflows
OIDC calls and separately authenticated browser previews.

Cloud Run IAM checks OIDC audience **before** requests reach protected `jobs`,
so it cannot accept dynamic workspace audiences. The public `api` route does
not have that Cloud Run IAM check; the application verifies the Google-signed
OIDC token, exact `BASE_URL` audience and allowed workflow service account
before any pod request. No `workflow-utils` changes or audience override is
needed. The existing production `jobs` routing is unchanged.

- `BASE_URL` for generated `*Dev` Workflows would use this prefix. Existing
  generated YAML sets OIDC `audience` to exactly `input.env.BASE_URL`.
- UI previews can use the same forwarding mechanism, with separate, short-lived
  browser authorization. Never expose arbitrary workspace ports anonymously.
- An authenticated gateway resolves an **owned** workspace ID to its current
  project lock, validates consumer generation/heartbeat, then resolves the
  ready pod **by its Kubernetes Job ownership**. Never trust a pod name, host,
  or namespace supplied by the HTTP request.
- The first transport to test is the already configured GKE API server's
  `pods/proxy` HTTP route (no new load balancer). It needs explicit permissions
  and an end-to-end connectivity test before use. Any IAM/RBAC changes must be
  managed through Terraform. Switch to a different transport behind the same
  gateway URL if control-plane proxying isn't suitable.
- The API validates the Google OIDC token, expected audience,
  and allowed service account exactly once. Do not forward the original OIDC
  token to the pod. Preview links should be individually signed,
  short lived, and revoked when the workspace generation stops. Caller tokens
  must not be forwarded to the local development server.
- `Dev` naming and deployment remain unchanged; production workflows must not
  be modified. The gateway should return a clean 410/503 when the consumer is
  stopped or the server port isn't listening.
- A path prefix alone cannot support every UI that assumes root-relative
  assets or WebSocket HMR. Test both cases; add shared host-based routing only
  if needed rather than claiming full UI compatibility from HTTP alone.

Status: gateway is behind the `AWFL_DEV_GATEWAY_ENABLED` flag. Test with a
zero-traffic `api` revision before promoting it to normal requests.
