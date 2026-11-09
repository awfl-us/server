# Consumer image library

All three images use the same `cloud/sse-consumer/Dockerfile` and the same AWFL
CLI (`awfl run`), lock, GCS workspace sync and credential refresh. Only the
developer tooling changes:

| Profile | Docker target | Extra tools |
| --- | --- | --- |
| `lightweight` (default) | `lightweight` | Python, Node, Git, gh, gcloud |
| `browser` | `browser` | Chromium and Playwright |
| `scala` | `scala` | Java 21 JDK and sbt 1.11.0 |

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

An already-running project consumer always stays on its existing image. Stop
the shared consumer before changing profiles; stopping interrupts other
sessions in that project. Every profile uses the same project lock and GKE Job
creator. `environment_status` reports installed tools from the live heartbeat.
