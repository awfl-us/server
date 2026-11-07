import { z } from 'zod';
const id = z.string().regex(/^[a-f0-9]{32}$/);
const workspace = { workspace_id: id };
export const tools = {
  request_result: { description: 'Recover the result of an MCP call that returned pending, without repeating its side effects.', schema: { ...workspace, request_id: z.number().int().min(1).max(2000) }, readOnly: true },
  environment_status: { description: 'Inspect control-plane or workspace health using the shared project consumer lock.', schema: { workspace_id: id.optional() }, readOnly: true },
  projects_list: { description: 'List your AWFL projects ordered by most recently updated, with project IDs, names, remote URLs, and timestamps. Read-only; no workspace required.', schema: { limit: z.number().int().min(1).max(200).default(50) }, readOnly: true },
  workspace_create: { description: 'Attach to the existing project-scoped AWFL consumer, starting it via the normal producer lock if absent. Requires project_id. Optional session_id scopes events in AWFL history. The consumer is shared with all other clients.', schema: { project_id: z.string().min(1).max(128), session_id: z.string().min(1).max(128).optional() } },
  run_command: { description: 'Execute Bash using the existing AWFL RUN_COMMAND tool. Returns stdout, stderr and exitCode on completion; use request_result if pending. Optional cwd affects this command only. Obtain user approval before destructive operations.', schema: { ...workspace, command: z.string().min(1).max(16384), cwd: z.string().max(4096).optional(), timeout: z.number().int().min(1).max(900).default(120) } },
  read_file: { description: 'Read a UTF-8 file using the existing AWFL READ_FILE tool.', schema: { ...workspace, path: z.string().min(1).max(4096) }, readOnly: true },
  write_file: { description: 'Create or replace a workspace file. Obtain approval before destructive overwrites.', schema: { ...workspace, path: z.string().min(1).max(4096), content: z.string().max(32768) } },
  workspace_stop: { description: 'Stop the shared project consumer using the same shutdown path as /producer/stop (Kubernetes Job shutdown, then project lock release). Interrupts other sessions. Requires explicit confirmation; workspace_create starts a new consumer.', schema: { ...workspace, confirm: z.literal(true) } },
};
export const consumerNames = { run_command: 'RUN_COMMAND', read_file: 'READ_FILE', write_file: 'UPDATE_FILE' };
