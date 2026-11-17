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

## November 17: eviction retry and Job-state handling

An AWFL lightweight pod was evicted because its **per-pod** ephemeral local
storage exceeded **1Gi**. This is separate from the Kubernetes namespace's
storage quota. New lightweight, browser, and Scala Jobs now request and limit
ephemeral storage at 4Gi (CPU and memory profiles are unchanged).

A Kubernetes Job can report `status.failed: 1` and `status.active: 1` after
the controller launches a replacement. The earlier broker classified every
nonzero failed count as a terminal Job failure and returned 403 for the
replacement's Firebase bootstrap. The classifier now:

- Rejects a deleting Job and Jobs with terminal `Failed`, `FailureTarget`,
  `Complete`, or `SuccessCriteriaMet` conditions.
- Accepts `status.active > 0` even when previous pod failures were recorded.
- Treats retry backoff as `pending` until the configured `backoffLimit` is
  exceeded; rejects exhausted retries.
- Retains the existing project grant, 256-bit capability and competing
  active-lock checks. No credential or authorization fallback is introduced.

Credential bootstrap 403 responses now record a **reason category** in
server logs without logging secrets. If 403 recurs after this fix, check whether
it is `job_not_running`, `consumer_grant_replaced`, or
`different_active_lock` before changing the authorization policy.

Both the Job classification and resource requests are applied to **new**
Kubernetes Jobs. Already-failed or already-running Jobs cannot have their
immutable Job specs updated and must be cleanly restarted after rollout.
