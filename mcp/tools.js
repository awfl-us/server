import { z } from 'zod';

const id = z.string().regex(/^[a-f0-9]{32}$/);
const executionId = z.string().regex(/^(?:[a-f0-9]{32}|exec_[a-f0-9]{32}_[0-9]{8})$/);
const path = z.string().min(1).max(4096);
const workspace = { workspace_id: id };

export const tools = {
  request_result: {
    description: 'Recover a previous MCP request by its legacy request number without resubmitting work.',
    schema: { ...workspace, request_id: z.number().int().min(1).max(2000) }, readOnly: true,
  },
  environment_status: {
    description: 'Discover the shared GKE consumer readiness, queue, and LIVE environment: tool availability, GCP/GitHub credential presence and token-file names (never secret values). Call with workspace_id after attaching a project. Stale heartbeat means unknown, not absent credentials. Full instructions: awfl://environment/guide.',
    schema: { workspace_id: id.optional() }, readOnly: true,
  },
  projects_list: {
    description: 'List your owned AWFL projects by recent update.',
    schema: { limit: z.number().int().min(1).max(200).default(50) }, readOnly: true,
  },
  workspace_create: {
    description: 'Attach to or start the existing project-scoped AWFL consumer; never creates a second execution backend. idle_timeout_seconds applies only when starting a new consumer, not when attaching to an existing one (default: 3600 seconds, range: 60-86400).',
    schema: { project_id: z.string().min(1).max(128), session_id: z.string().min(1).max(128).optional(),
      idle_timeout_seconds: z.number().int().min(60).max(86400).optional() },
  },
  run_command: {
    description: 'Execute Bash in the shared project consumer. Returns a durable execution_id immediately if not finished; poll command_output. An idempotency_key prevents duplicate side effects when retrying. A nonzero shell exit is a normal result, not an MCP transport error.',
    schema: {
      ...workspace, command: z.string().min(1).max(16384),
      cwd: path.optional(),
      timeout: z.number().int().min(1).max(900).optional(), // compatibility: seconds
      timeout_ms: z.number().int().min(1).max(3600000).optional(),
      yield_time_ms: z.number().int().min(0).max(15000).default(10000),
      max_output_bytes: z.number().int().min(1).max(1048576).default(65536),
      idempotency_key: z.string().min(1).max(256).optional(),
      session_id: z.string().min(1).max(128).optional(),
      interactive: z.boolean().optional(),
      pty: z.boolean().optional(),
      rows: z.number().int().min(1).max(1000).optional(),
      cols: z.number().int().min(1).max(1000).optional(),
    },
  },
  command_output: {
    description: 'Read persisted incremental stdout/stderr events of an execution, using a stable cursor; can long-poll for updates.',
    schema: { ...workspace, execution_id: executionId, cursor: z.number().int().min(0).default(0),
      wait_ms: z.number().int().min(0).max(15000).default(0),
      max_bytes: z.number().int().min(1).max(1048576).default(65536) }, readOnly: true,
  },
  command_input: {
    description: 'Send input, EOF, signal or PTY dimensions to an interactive command. Input requires interactive:true or pty:true at startup.',
    schema: { ...workspace, execution_id: executionId,
      input: z.string().max(65536).optional(),
      input_base64: z.string().max(87384).optional(),
      eof: z.boolean().optional(),
      signal: z.enum(['SIGINT', 'SIGTERM']).optional(),
      rows: z.number().int().min(1).max(1000).optional(),
      cols: z.number().int().min(1).max(1000).optional() },
  },
  command_cancel: {
    description: 'Cancel a running process group. Does not stop other commands or the shared consumer.',
    schema: { ...workspace, execution_id: executionId },
  },
  read_file: {
    description: 'Read a bounded text/byte or line range with optional line numbers, hash, mtime and encoding.',
    schema: { ...workspace, path,
      offset: z.number().int().min(0).optional(), max_bytes: z.number().int().min(1).max(1048576).optional(),
      start_line: z.number().int().min(1).optional(), end_line: z.number().int().min(1).optional(),
      include_line_numbers: z.boolean().optional(), expected_hash: z.string().length(64).optional(),
      encoding: z.enum(['utf-8', 'base64']).optional(), with_metadata: z.boolean().optional() }, readOnly: true,
  },
  write_file: {
    description: 'Atomically create or replace a workspace file with optional optimistic hash and no-overwrite checks.',
    schema: { ...workspace, path, content: z.string().max(262144),
      create_only: z.boolean().optional(), expected_hash: z.string().length(64).optional(),
      create_parents: z.boolean().optional(), encoding: z.enum(['utf-8', 'base64']).optional(),
      permissions: z.string().regex(/^[0-7]{3,4}$/).optional() },
  },
  apply_patch: {
    description: 'Validate all contexts then apply a multi-file Begin Patch diff, with rollback, path safeguards and expected SHA-256 hashes. Supports add/update/delete/move.',
    schema: { ...workspace, patch: z.string().min(1).max(262144),
      atomic: z.boolean().default(true), cwd: path.optional(),
      expected_hashes: z.record(z.string(), z.string().length(64)).optional() },
  },
  search_files: {
    description: 'Search repository contents or filenames recursively with line numbers, excerpts, regex/literal and pagination.',
    schema: { ...workspace, root: path.optional(), pattern: z.string().min(1).max(4096),
      mode: z.enum(['content', 'filename']).default('content'),
      glob: z.union([z.string(), z.array(z.string())]).optional(),
      regex: z.boolean().optional(), case_sensitive: z.boolean().optional(),
      context_lines: z.number().int().min(0).max(10).optional(),
      include_hidden: z.boolean().optional(), respect_gitignore: z.boolean().optional(),
      max_results: z.number().int().min(1).max(500).optional(),
      offset: z.number().int().min(0).optional() }, readOnly: true,
  },
  list_directory: {
    description: 'List entries with types, sizes, permissions and modification times, optionally recursively.',
    schema: { ...workspace, path: path.optional(),
      recursive: z.boolean().optional(), max_depth: z.number().int().min(1).max(16).optional(),
      include_hidden: z.boolean().optional(), max_entries: z.number().int().min(1).max(1000).optional() }, readOnly: true,
  },
  workspace_stop: {
    description: 'Stop the shared consumer and delete its ephemeral files. Interrupts other sessions. Explicit confirmation required.',
    schema: { ...workspace, confirm: z.literal(true) },
  },
};

export const consumerNames = {
  run_command: 'RUN_COMMAND', command_input: 'COMMAND_INPUT', command_cancel: 'COMMAND_CANCEL',
  read_file: 'READ_FILE', write_file: 'UPDATE_FILE', apply_patch: 'APPLY_PATCH',
  search_files: 'SEARCH_FILES', list_directory: 'LIST_DIRECTORY',
};
