Agent Development Guidelines (General)

These principles are broadly applicable across projects and help avoid fragile integrations, reduce noise, and improve reliability.

1) Stream and protocol hygiene
- Only emit messages defined by the protocol on the data channel. Keep control-plane messages (internal syncs, diagnostics) off the data stream.
- Prefer NDJSON or line-delimited framing for streams. Never interleave non-protocol text with protocol JSON.
- Use heartbeats/keepalives with a simple, documented format and interval.
- Treat request end and socket close separately; keep streams open as intended and clean up on close.

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

11) Protocol vs. application failures
- Separate transport/delivery from business outcome. Acknowledge and advance cursors/offsets based on delivery/completion, not only on success.
- Treat tool/handler errors as valid outcomes: return { id, error } (or { id, result }) rather than surfacing them as transport failures.
- Reserve retries/rejections for transport/runtime faults (timeouts, connection loss, framing errors), not expected tool errors (e.g., ENOENT, nonzero exit).
- Callbacks should carry structured fields (e.g., result and error) and remain backward-compatible; when necessary, wrap payloads or version schemas.
- Log at high-signal points (send/receive/commit) and keep retry policy explicit and bounded for transport faults.

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

These guidelines are intended to remain stable; refine cautiously and keep examples generic rather than project-specific.