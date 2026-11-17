# GKE consumer Firebase authentication after pod rescheduling

GKE Autopilot may evict a consumer pod while its Kubernetes Job remains active.
The Job then recreates the pod with its original PodSpec. Previously, that
PodSpec contained a short-lived Firebase custom/ID token, so an hours-later
restart failed `INVALID_CUSTOM_TOKEN`. During SIGTERM the old pod also
released its project lock, making the normal credential refresh endpoint reject
the replacement.

For new GKE Jobs:

- The immutable PodSpec no longer contains short-lived Firebase tokens.
- The shell entrypoint requests a freshly minted Firebase custom token from
  the API broker before starting `awfl run`, regardless of optional Google
  Cloud or GitHub integrations.
- The request is authenticated with the existing 256-bit consumer capability,
  bound to its user, project, consumer ID and current stored grant.
- The bootstrap route verifies that the Kubernetes Job still exists and is
  running/pending, and refuses if a different consumer has a live project lock.
  Standard OAuth credential refresh and storage-token routes still require the
  existing live lock.
- Bootstrap retries transient errors but refuses to start with stale credentials
  if refresh cannot be authorized.

Verified by synthetic end-to-end HTTPS tests running the real Python bootstrap
shell, including a released-lock restart, a deleted Job, a different active
lock holder, and rejection of stale PodSpec ID tokens. Existing producer/start,
OAuth and image-profile tests continue to pass.

Existing Kubernetes Jobs have immutable PodSpecs and will **not** gain this fix
retroactively. They must be deleted and started again after deployment.

Deployment requires both the API and Jobs services to run the new server commit.
The consumer image itself does not need rebuilding: the bootstrap uses its
existing Python 3 runtime and the existing CLI.
