# AWFL server — agent instructions

Read [AGENT.md](AGENT.md) for general guidance.

**Default to local native development in the existing Scala GKE
environment.** Before redeploying Cloud Run, read
[docs/native-local-development.md](docs/native-local-development.md).
Run the whole existing Jobs Express service with `npm run start:jobs` on
localhost:5055 in a persistent interactive terminal, and run the actual
compiled Rust executor locally. Use `npm run native:local` for a separate,
fast *recorded-HTTP replay* path, not as evidence of fresh network calls.

Avoid redeployment/Cloud Tasks/GCS publication for every fix. Verify
real IAM/Firestore/GCS with an isolated cloud canary only after local
tests pass. Never expose the locally trusted Jobs port publicly;
infra/IAM changes require Terraform.


**Detached native subworkflows:** `workflow.run` with
`connector_params.skip_polling=true` must create an independent pinned
native execution and return its name immediately—never recursively await
the child. The persistent GKE Jobs scheduler and Firestore `asyncLaunch`
recovery scan implement this path in
`workflows/native/{durableSubworkflow,asyncScheduler,worker,executionStore}.js`.
See `workflows/native/MEMORY.md`. In production this requires the
explicit `AWFL_NATIVE_DETACHED_GKE_ENABLED=1` flag and a persistent
GKE Jobs process (not request-scoped Cloud Run). No new Cloud Task per
native subworkflow. Keep all IAM and infrastructure Terraform-managed.
