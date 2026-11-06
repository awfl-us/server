import { z } from 'zod';
const id = z.string().regex(/^[a-f0-9]{32}$/);
const workspace = { workspace_id: id };
export const tools = {
  request_result: { description: 'Recover the result of an MCP call that returned pending, without repeating its side effects.', schema: { ...workspace, request_id: z.number().int().min(1).max(2000) }, readOnly: true },
  environment_status: { description: 'Inspect control-plane or workspace health. Workspace health is reported by the Python consumer.', schema: { workspace_id: id.optional() }, readOnly: true },
  workspace_create: { description: 'Create or attach to the existing AWFL cloud consumer. Optionally select an owned AWFL project to use its existing GitHub credentials. Workspace survives commands until stop or expiry.', schema: { project_id: z.string().min(1).max(128).optional() } },
  run_command: { description: 'Execute Bash in the AWFL Python consumer. Returns an execution ID and initial output; use command_output for subsequent chunks. Explicit cwd persists. Shell-local cd/export do not persist. Obtain user approval before destructive operations.', schema: { ...workspace, command: z.string().min(1).max(16384), cwd: z.string().max(4096).optional(), timeout: z.number().int().min(1).max(900).default(120) } },
  command_output: { description: 'Poll incremental stdout/stderr using next_cursor. Continue while running or has_more.', schema: { ...workspace, execution_id: id, cursor: z.number().int().nonnegative().default(0) }, readOnly: true },
  command_cancel: { description: 'Kill a command and its process group without deleting workspace files.', schema: { ...workspace, execution_id: id, cursor: z.number().int().nonnegative().default(0) } },
  read_file: { description: 'Read a bounded UTF-8 file range inside the workspace. Offsets are bytes.', schema: { ...workspace, path: z.string().min(1).max(4096), offset: z.number().int().nonnegative().default(0), max_bytes: z.number().int().min(1).max(32768).default(32768) }, readOnly: true },
  write_file: { description: 'Create or replace a workspace file. Obtain approval before destructive overwrites.', schema: { ...workspace, path: z.string().min(1).max(4096), content: z.string().max(32768) } },
  workspace_stop: { description: 'Stop the cloud workspace and delete all its ephemeral files and running commands. Requires explicit confirmation.', schema: { ...workspace, confirm: z.literal(true) } },
};
export const consumerNames = { run_command: 'RUN_COMMAND', read_file: 'READ_FILE', write_file: 'UPDATE_FILE', command_output: 'COMMAND_OUTPUT', command_cancel: 'COMMAND_CANCEL', environment_status: 'ENVIRONMENT_STATUS' };
