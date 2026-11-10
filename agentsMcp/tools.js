import { z } from 'zod';

const project_id = z.string().min(1).max(128);
const session_id = z.string().min(1).max(128);
const first = z.number().int().min(1).max(100).default(50);
const after = z.string().min(1).max(1024).optional();
const fund = z.number().positive().max(100).default(1);
const model = z.string().min(1).max(128).default('gpt-5');
const prompt = z.string().min(1).max(16000);
const message = z.string().min(1).max(16000);

export const agentTools = {
  projects_list: {
    description: 'List your existing AWFL projects. Choose a project_id for all session tools.',
    schema: { limit: z.number().int().min(1).max(200).default(50) }, readOnly: true,
  },
  list_agents: {
    description: 'List AWFL agents, including file-defined agents, for starting sessions.',
    schema: { first }, readOnly: true,
  },
  list_sessions: {
    description: 'List existing AWFL sessions in one project, most recently updated first. Follow end_cursor.',
    schema: { project_id, first, after }, readOnly: true,
  },
  get_session: {
    description: 'Read a session, linked agent/workflow and latest execution status.',
    schema: { project_id, session_id }, readOnly: true,
  },
  list_messages: {
    description: 'Read raw chronological messages in an AWFL session, including tool messages. Follow end_cursor to continue.',
    schema: { project_id, session_id, first, after }, readOnly: true,
  },
  review_session: {
    description: 'Review session metadata, latest execution status, and one page of conversation history. Full history uses list_messages.',
    schema: { project_id, session_id, first, after }, readOnly: true,
  },
  create_session: {
    description: 'Launch an AWFL agent using the EXISTING workflow execution endpoint and session-agent mapping. Provide agent_id from list_agents or workflow_name to create a workflow-backed agent. fund is the existing AWFL per-execution dollar budget (default $1). A failed network response is not proof the agent did not start; do not retry blindly.',
    schema: { project_id, prompt, agent_id: z.string().min(1).max(128).optional(),
      workflow_name: z.string().min(1).max(128).optional(),
      model, fund, background: z.boolean().default(false) },
  },
  send_message: {
    description: 'Send instructions or follow-up to the SAME AWFL session and linked workflow. This starts a normal AWFL workflow execution on that session; do not retry blindly after a network error.',
    schema: { project_id, session_id, message, model, fund, background: z.boolean().default(false) },
  },
  terminate_session: {
    description: 'Cancel the session latest execution, ancestors and descendants using the EXISTING AWFL stop-execution logic. Interrupts agents; confirmation required.',
    schema: { project_id, session_id, confirm: z.literal(true) },
  },
  search_conversations: {
    description: 'Search recent AWFL conversations for case-insensitive literal terms separated by AND. Results are project-scoped and include ranked excerpts. A session with >100 messages has incomplete search coverage. Follow end_cursor for more sessions.',
    schema: { project_id, query: z.string().min(1).max(400), first: z.number().int().min(1).max(20).default(10),
      after, max_messages: z.number().int().min(1).max(250).default(250) }, readOnly: true,
  },
  search_session_matches: {
    description: 'Find additional literal matches in one session. Return chronological matching messages; an empty page may still have a continuation cursor.',
    schema: { project_id, session_id, query: z.string().min(1).max(400), first, after,
      exclude_message_ids: z.array(z.string().min(1)).max(100).default([]) }, readOnly: true,
  },
  launch_batch: {
    description: 'Launch up to 10 independent AWFL sessions sequentially. Each uses the normal workflow launcher; partial failures are returned, with no automatic retry or rollback.',
    schema: { sessions: z.array(z.object({
      project_id, prompt, agent_id: z.string().min(1).max(128).optional(),
      workflow_name: z.string().min(1).max(128).optional(),
      model, fund, background: z.boolean().default(false),
    })).min(1).max(10) },
  },
  message_batch: {
    description: 'Send one instruction to up to 10 AWFL sessions sequentially, using the same normal send_message path.',
    schema: { project_id, session_ids: z.array(session_id).min(1).max(10),
      message, model, fund, background: z.boolean().default(false) },
  },
};
