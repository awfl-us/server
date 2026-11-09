# AWFL workspace HTTP gateway (in progress)

Goal: reuse the existing public HTTPS API for both development Google Workflows
callbacks and browser previews of servers running *inside* the project-scoped
GKE consumer. No additional workflows, workflow suffixes, public pod IPs, or
per-workspace load balancers are needed.

Proposed URL (not deployed):

`https://api.awfl.us/dev/{workspace-id}/{port}/{relative-path}`

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
- The Workflows side must validate its Google OIDC token, expected audience,
  and allowed service account. Preview links should be individually signed,
  short lived, and revoked when the workspace generation stops. Caller tokens
  must not be forwarded to the local development server.
- `Dev` naming and deployment remain unchanged; production workflows must not
  be modified. The gateway should return a clean 410/503 when the consumer is
  stopped or the server port isn't listening.
- A path prefix alone cannot support every UI that assumes root-relative
  assets or WebSocket HMR. Test both cases; add shared host-based routing only
  if needed rather than claiming full UI compatibility from HTTP alone.

Status: initial URL construction and header-filtering tests pass. No route is
mounted in the public API yet. No infrastructure has been applied.
