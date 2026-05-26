SSE Consumer - Tool callbacks and RUN_COMMAND timeout behavior

RUN_COMMAND timeout configuration
- Default: Controlled by env RUN_COMMAND_TIMEOUT_SECONDS (seconds). If unset, defaults to 60s via config. If set to 0 or a non-finite value, the default becomes unlimited (no timeout).
- Event-level override: Top-level field timeout_seconds on the event object controls the timeout for RUN_COMMAND.
  - Omitted/undefined: use the env default (RUN_COMMAND_TIMEOUT_SECONDS).
  - null: unlimited (no timeout) — child_process.exec gets timeout=0.
  - number: that many seconds (no clamping/upper bound applied).
- Args-level: args.timeoutSeconds is still honored, but the top-level timeout_seconds takes precedence when provided.
- Output limiting and maxBuffer safeguards remain in place.

Supported locations
- SSE stream consumer (app/sse/consumer.js): reads event.timeout_seconds and forwards to tools.doRunCommand.
- Pub/Sub consumer worker (app/worker.js): reads event.timeout_seconds and forwards to tools.doRunCommand.

Workdir note
- SSE consumer supports a top-level workdir string on the event object to override the active working directory for file and command tools. Paths are resolved safely within the work root.

Examples
- Unlimited per-event timeout:
  {
    "tool": "RUN_COMMAND",
    "args": { "command": "sleep 600" },
    "timeout_seconds": null
  }

- Custom per-event timeout:
  {
    "tool": "RUN_COMMAND",
    "args": { "command": "bash -lc 'long_task'" },
    "timeout_seconds": 1800
  }

- Global default unlimited:
  Set RUN_COMMAND_TIMEOUT_SECONDS=0 in the environment.
