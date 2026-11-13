Native Rust / ProjectManager development (high priority)
- **Local-first:** use the existing Scala GKE development environment. Run the entire Jobs Express application and native Rust executor locally before proposing a Cloud Run deployment or Cloud Tasks dispatch.
- Read `docs/native-local-development.md` for the exact startup command, persistent interactive terminal requirement, local Jobs routes, and test phases.
- From the server checkout, start `PORT=5055 GCP_PROJECT=awfl-us GOOGLE_CLOUD_PROJECT=awfl-us WORKFLOWS_BASE_URL=http://127.0.0.1:5055 npm run start:jobs`. Verify health from a separate tool execution. Never expose this upstream-trusting listener publicly.
- `npm run native:local` replays **recorded** HTTP responses using real compiled Rust binaries; local Jobs provides actual Express route implementations, but downstream Firestore/GCS/LLM still need suitable credentials. Report the distinction.
- Iterate locally, then use a zero-traffic native Cloud Run canary only for real-cloud integration. Terraform owns infrastructure and IAM.

Agent Development Guidelines (General)

TL;DR quick reference
- Keep data streams clean: only protocol on data channels; separate control-plane.
- Default to minimal, structured logs; redact secrets; include stable ids and timings.
- Treat tool/business failures as valid results; reserve retries for transport faults.
- Prefer per-run ephemeral resources; bind IAM least-privilege and scope credentials narrowly.
- Make side effects idempotent with stable keys; commit cursors/state only after business completion.
- Apply explicit backpressure; make it observable; keep concurrency non-blocking and isolated.
- Enforce filesystem/subprocess guards (scoped paths, time/size limits, normalized encodings).
- Graceful, idempotent shutdown; clear timers/listeners and bound finalization by time.
- Prefer additive, backward-compatible changes; version when breaking and gate via feature flags.
- Keep cheap observability (counters/timings/health) and consistent correlation across logs/metrics.

These principles are broadly applicable across projects and help avoid fragile integrations, reduce noise, and improve reliability.

1) Stream and protocol hygiene
- Only emit messages defined by the protocol on the data channel. Keep control-plane messages (internal syncs, diagnostics) off the data stream.
- Prefer NDJSON or line-delimited framing for streams. Never interleave non-protocol text with protocol JSON.
- Use heartbeats/keepalives with a simple, documented format and interval.
- Treat request end and socket close separately; keep streams open as intended and clean up on close.
- Apply backpressure: pause input sources (SSE, gRPC, message readers) when queues exceed thresholds; resume when drained. Keep this behavior explicit and observable.

2) Structured logging and verbosity
- Default to minimal, high-signal logs (start/done, error summaries). Make verbose traces opt-in via env flags.
- Redact secrets in logs (auth headers, tokens). Avoid dumping raw request bodies unless necessary.
- Use stable, structured fields to aid correlation (ids, timings, counts).

3) Robust event handling
- Be liberal in what you accept: tolerate extra fields and minor schema variations; detect intent (e.g., callback/tool) by multiple cues when reasonable.
- Always correlate tool execution with an id when present; return either { id, result } or { id, error }.
- Avoid top-level fields that could collide with protocol semantics (e.g., do not emit arbitrary top-level "error" objects on shared channels).

4) Background work and concurrency
- Run background jobs (syncs, refreshers) without blocking the main event loop or stream handling.
- Prevent overlapping runs of the same job; use lightweight locks/flags.
- Keep background activity from emitting on client-facing streams unless explicitly part of the protocol.

5) Configuration defaults
- Choose safe, non-intrusive defaults. Use 0/empty values to disable optional behaviors by default.
- Gate optional or noisy features behind explicit env flags.
- Validate required configuration early and fail with clear messages.

6) Error handling
- Distinguish between user-facing errors and internal errors; include actionable messages without leaking sensitive data.
- Prefer structured error payloads with a stable shape and codes over free-form text.
- Handle expected errors (e.g., missing files) gracefully and document when they are normal.

7) Filesystem and command execution
- Always resolve paths within an allowed root to avoid escapes.
- Enforce size/time limits on I/O and subprocesses.
- Normalize line endings and encodings where applicable; document assumptions.

8) Resource lifecycle and shutdown
- Make teardown idempotent; clear intervals/timeouts/listeners on close.
- Add graceful shutdown hooks to flush critical work within a bounded time.
- Prefer fire-and-forget finalization over blocking shutdown when time-limited.

9) Observability and diagnostics
- Include cheap counters/timings (e.g., items processed, bytes) in start/done logs.
- Provide a health endpoint for liveness/readiness.
- Keep correlation ids consistent across logs, responses, and metrics.

10) Security posture
- Make authentication/authorization explicit and optional by configuration; fail closed when enabled.
- Scope credentials narrowly (least privilege) and never log raw secrets.
- Prefer service account impersonation with resource-scoped IAM for brokered services; avoid relying on downscoped or CAB tokens where not supported.

11) Protocol vs. application failures
- Separate transport/delivery from business outcome. Acknowledge and advance cursors/offsets based on delivery/completion, not only on success.
- Treat tool/handler errors as valid outcomes: return { id, error } (or { id, result }) rather than surfacing them as transport failures.
- Reserve retries/rejections for transport/runtime faults (timeouts, connection loss, framing errors), not expected tool errors (e.g., ENOENT, nonzero exit).
- Callbacks should carry structured fields (e.g., result and error) and remain backward-compatible; when necessary, wrap payloads or version schemas.
- Log at high-signal points (send/receive/commit) and keep retry policy explicit and bounded for transport faults.

12) Brokered request-reply patterns (Pub/Sub, Kafka, SQS/SNS)
- Prefer explicit request and reply channels with server-side filters/selectors where supported; enforce isolation at the subscription/consumer binding layer.
- Use attributes/headers to carry routing context and correlate by a stable tuple (e.g., session_id, type, seq). Keep correlation consistent across producer, broker, and consumer logs.
- Define offset/cursor advancement policy up front: deliver-once vs process-once. It is valid to gate cursor advancement on business completion (e.g., after a callback) when product semantics require it.
- Design for at-least-once delivery: make handlers idempotent and include idempotency keys on side-effecting calls (e.g., callback_id + seq).
- Keep request and reply payloads small and self-describing; put large blobs in object storage with signed URLs when needed.
- For ephemeral workflows, prefer per-run filtered subscriptions with TTLs and explicit teardown on completion. Bind subscriber IAM at the subscription scope (least privilege) and keep publisher rights scoped to only the needed topic.

13) Cryptography and sensitive material
- Use authenticated encryption (e.g., AES-256-GCM) and bind Additional Authenticated Data (AAD) to routing metadata to prevent cross-context replay (e.g., user_id, project_id, session_id, channel, type, seq).
- Generate fresh, per-run keys where feasible; rotate keys and keep versions in metadata (e.g., enc="a256gcm:v1").
- Enforce nonce uniqueness and document the nonce size and encoding; include compact wrappers (e.g., { v, n, ct, tag }).
- Never log raw keys, nonces, or plaintext; redact secrets consistently and test redaction paths.
- Provide minimal, well-tested crypto helpers and test vectors; avoid bespoke schemes and keep dependencies small.

14) Idempotency and retries
- Make externally visible operations (callbacks, state transitions) idempotent via stable keys; retries should not produce duplicate side effects.
- Prefer bounded, exponential backoff with jitter for retries; record attempts and escalate after a cap.
- Treat poison messages explicitly: surface structured errors, move to a dead-letter path or mark for later inspection without blocking the stream.

15) Compatibility and evolution
- Prefer additive, backward-compatible changes. When breaking changes are unavoidable, version payloads/schemas and include version metadata.
- Use feature flags and staged rollouts; support dual-read/dual-write during migrations where sensible.
- Provide deprecation windows with clear logs/metrics to guide safe cutover.

Appendix: General, reusable learnings
- Keep wire schemas small, explicit, and stable. Evolve them backward-compatibly and prefer clear field names (e.g., output over stdout, error over stderr) to avoid ambiguity.
- Treat tool errors as successful protocol outcomes so cursors/offsets can advance. Return structured error payloads rather than failing transport.
- Never interleave logs with protocol streams. Default to high-signal start/done logging; gate verbose traces behind env flags.
- Propagate correlation identifiers (ids) end-to-end without mutation across producer, consumer, and callbacks.
- Separate transport from business outcome: retries are for transport faults; business/tool failures are results to record.
- Avoid overlapping background runs; isolate background activity from client-facing streams and keep it non-blocking.
- Prefer safe, minimal defaults and feature flags. Validate configuration early and surface clear, actionable errors.
- Enforce filesystem and subprocess guards (root scoping, timeouts, size limits) and normalize encodings/line endings.
- Make shutdown graceful and idempotent. Clear timers/listeners and bound finalization by time.
- Maintain cheap observability (counters/timings, health endpoints) and keep correlation consistent across logs/metrics.
- Keep security least-privilege and explicit; avoid logging secrets; use audience-bound tokens where applicable.
- Test for parity across local and cloud environments; document any cloud-only behaviors and gate placeholders behind flags.
- Provide operational kill-switches (e.g., stopRequested flags) and clearly document placeholders and follow-up work when full wiring isn’t ready.
- Propagate deadlines/timeouts explicitly and prefer monotonic timers for intervals; avoid relying on wall clock for correctness.
- Keep dependency surface small, pin versions, and avoid heavy/unstable libraries in hot paths; review transitive risks.
- Respect quotas and rate limits; implement client-side rate limiting and error-aware backoff.
- Prefer configuration layering (env → file → runtime flags) and document precedence.
- Bind IAM at the most specific resource scope and prefer per-run, ephemeral resources with explicit TTL/teardown. Grant subscriber rights only at the subscription level when supported and keep publishers scoped to only necessary topics.
- Surface infrastructure identifiers as machine-readable outputs for CI/pipelines (ids, names, URLs). Ensure generation steps depend on created resources and never include secrets in these outputs.
- Prefer production-grade managed services in development for critical paths when feasible to ensure parity for auth/IAM and transport behavior; document exceptions and gate placeholders behind flags.
- Use distinct service identities per job/component and scope each identity to only the resources it needs to prevent cross-session or cross-run access.
- Keep repository layout and CI/CD in sync: validate expected paths in pipelines and fail fast when mismatches occur.
- Avoid duplicate templates or parallel definitions for the same component; choose one canonical location and deprecate the rest behind flags until cutover.
- Use a single source of truth for resource names and paths; wire them via configuration rather than scattering literals across scripts and docs.
- Add lightweight CI checks (path assertions, smoke builds) to catch drift between docs, code, and deployment scripts.
