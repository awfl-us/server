# Consumer image library

All three images use the same `cloud/sse-consumer/Dockerfile` and the same AWFL
CLI (`awfl run`), lock, GCS workspace sync and credential refresh. Only the
developer tooling changes:

| Profile | Docker target | Extra tools |
| --- | --- | --- |
| `lightweight` | `lightweight` | Python, Node, Git, gh, gcloud |
| `browser` | `browser` | Chromium and Playwright |
| `scala` | `scala` | Java 21, sbt 1.11.0, Rust/Cargo 1.99.1, Rustfmt, Clippy, GCC, musl cross-linker |

The existing Terraform-managed Artifact Registry `app` repository stores all
three; no new registry, cluster, service account, or consumer startup path is
needed. The merge workflow builds and publishes source-addressed image tags,
smoke-tests each, prewarms their GKE streaming caches and injects their exact
URIs into the API server environment. An unpublished profile is unavailable,
not silently substituted.

To select a profile, use the AWFL web start dropdown, submit
`{ "imageProfile": "scala" }` to `POST /workflows/producer/start`, or pass
`image_profile="scala"` to MCP `workspace_create` when attaching to a project.
Call `GET /workflows/producer/images` to inspect published options.

New shared project consumers require an **explicit image profile**; no image
is chosen silently. Scala has a 4 GiB ephemeral storage request and limit
(equal values for GKE Autopilot admission). Lightweight has a 1 GiB limit,
which caused an actual pod eviction during native compiler development.
Existing consumers are never replaced or restarted silently. MCP attachment
to an existing consumer may omit the image choice; creating a new one cannot.

An already-running project consumer always stays on its existing image. Stop
the shared consumer before changing profiles; stopping interrupts other
sessions in that project. Every profile uses the same project lock and GKE Job
creator. `environment_status` reports installed tools from the live heartbeat.

The Scala profile includes the Rust toolchain and linkers so a developer can
compile Scala DSL sources, build actual native Rust executables and run both
unit and effect-continuation tests directly in the project cloud environment.
The toolchains are installed in the image; they do not need ephemeral
`curl | sh` bootstrap on every consumer restart. The image also supports
`x86_64-unknown-linux-musl` for static ELF artifacts compatible with Alpine
Jobs. This does not affect native production execution feature flags.
