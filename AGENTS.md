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
