import { randomUUID } from 'node:crypto';
import { getFirestore } from 'firebase-admin/firestore';
import { projectScopedCollectionPath, userScopedCollectionPath } from '../workflows/utils.js';
import { sessionMapDocPath, loadFileDefinedAgents, resolveAgent, createAgentRecord, linkAgentSession } from '../workflows/agents/common.js';
import { latestSessionExecutions } from '../workflows/exec/statusService.js';
import { createWorkflowExecution } from '../workflows/services/executeWorkflow.js';
import { cancelExecutionChain } from '../workflows/exec/stop.js';

const MAX_CURSOR = 10000;
function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ v: 1, offset })).toString('base64url');
}
function parseCursor(cursor) {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (value.v === 1 && Number.isSafeInteger(value.offset) && value.offset >= 0 && value.offset <= MAX_CURSOR) {
      return value.offset;
    }
  } catch {}
  throw new Error('Invalid or expired pagination cursor');
}
function unwrap(data) {
  if (!data || typeof data !== 'object') return {};
  const value = data.value && typeof data.value === 'object' && !Array.isArray(data.value) ? data.value : {};
  return { ...data, ...value };
}
function mapSession(doc) {
  const raw = unwrap(doc.data());
  return { id: doc.id, title: raw.title || raw.name || doc.id, updated_at: raw.update_time ?? null,
    created_at: raw.create_time ?? null, summary: raw.summary ?? null, tags: raw.tags ?? [],
    agent_id: raw.agentId ?? null, workflow_name: raw.workflowName ?? null };
}
function mapMessage(doc) {
  const raw = unwrap(doc.data());
  return { id: doc.id, role: raw.role ?? null, content: raw.content ?? null,
    tool_calls: raw.tool_calls ?? null, tool_call_id: raw.tool_call_id ?? null,
    create_time: raw.create_time ?? null, cost: raw.cost ?? null,
    calling_exec_id: raw.callingExecId ?? null, current_exec_id: raw.currentExecId ?? null };
}
function page(items, offset, limit, key) {
  const more = items.length > limit;
  return { [key]: items.slice(0, limit), end_cursor: more ? encodeCursor(offset + limit) : null, has_next_page: more };
}
function normalizedTerms(query) {
  // AND-separated literal phrases, including quoted text containing AND.
  const terms = [];
  let current = '', quoted = false;
  for (let i = 0; i < query.length; i++) {
    const ch = query[i];
    if (ch === '"') { quoted = !quoted; continue; }
    if (!quoted && /^\s+AND\s+/i.test(query.slice(i))) {
      const sep = /^\s+AND\s+/i.exec(query.slice(i))[0];
      if (current.trim()) terms.push(current.trim().toLowerCase());
      current = '';
      i += sep.length - 1;
    } else current += ch;
  }
  if (current.trim()) terms.push(current.trim().toLowerCase());
  if (!terms.length || terms.length > 8) throw new Error('Search needs 1-8 literal AND terms');
  return terms;
}
function messageText(message) {
  if (typeof message.content === 'string') return message.content;
  if (message.content == null) return '';
  return JSON.stringify(message.content);
}

export class AgentSessionService {
  constructor({ db = getFirestore(), execute = createWorkflowExecution,
    getStatuses = latestSessionExecutions, cancel = cancelExecutionChain } = {}) {
    Object.assign(this, { db, execute, getStatuses, cancel });
  }
  async ensureProject(userId, projectId) {
    if (!projectId) throw new Error('project_id is required');
    const project = await this.db.doc(userScopedCollectionPath(userId, `projects/${projectId}`)).get();
    if (!project.exists) throw new Error('Project not found');
    return project.data() || {};
  }
  async listAgents(userId, { first = 50 } = {}) {
    const snapshot = await this.db.collection(userScopedCollectionPath(userId, 'agents'))
      .orderBy('created', 'desc').limit(first).get();
    const found = new Map(snapshot.docs.map(doc => [doc.id, { ...doc.data(), id: doc.id }]));
    for (const agent of await loadFileDefinedAgents()) if (!found.has(agent.id)) found.set(agent.id, agent);
    return { agents: [...found.values()] };
  }
  async listSessions(userId, { project_id, first = 50, after } = {}) {
    await this.ensureProject(userId, project_id);
    const offset = parseCursor(after);
    const collection = projectScopedCollectionPath(userId, project_id, 'convo.sessions');
    const docs = await this.db.collection(collection).orderBy('update_time', 'desc')
      .offset(offset).limit(first + 1).get();
    return { project_id, ...page(docs.docs.map(mapSession), offset, first, 'sessions') };
  }
  async sessionRecord(userId, projectId, sessionId) {
    const [session, mapping] = await Promise.all([
      this.db.doc(projectScopedCollectionPath(userId, projectId, `convo.sessions/${sessionId}`)).get(),
      this.db.doc(sessionMapDocPath(userId, projectId, sessionId)).get(),
    ]);
    if (!session.exists && !mapping.exists) throw new Error('Session not found');
    return { session, mapping, agentId: mapping.exists ? mapping.data().agentId : null };
  }
  async getSession(userId, { project_id, session_id }) {
    await this.ensureProject(userId, project_id);
    const { session, agentId } = await this.sessionRecord(userId, project_id, session_id);
    const executions = await this.getStatuses({ db: this.db, userId, projectId: project_id, sessionId: session_id, limit: 1 });
    let agent = agentId ? await resolveAgent(userId, agentId, this.db) : null;
    return {
      project_id, session_id, session: session.exists ? mapSession(session) : null,
      agent_id: agentId, agent_name: agent?.name ?? null, workflow_name: agent?.workflowName ?? null,
      status: executions[0]?.status ?? (session.exists ? 'unknown' : 'initializing'),
      latest_execution: executions[0] ?? null,
    };
  }
  async listMessages(userId, { project_id, session_id, first = 50, after } = {}) {
    await this.ensureProject(userId, project_id);
    await this.sessionRecord(userId, project_id, session_id);
    const offset = parseCursor(after);
    const path = projectScopedCollectionPath(userId, project_id, `convo.sessions/${session_id}/messages`);
    const snapshot = await this.db.collection(path).orderBy('create_time', 'asc')
      .offset(offset).limit(first + 1).get();
    return { session_id, ...page(snapshot.docs.map(mapMessage), offset, first, 'messages') };
  }
  async reviewSession(userId, args) {
    const [session, transcript] = await Promise.all([
      this.getSession(userId, args), this.listMessages(userId, args),
    ]);
    return { ...session, ...transcript };
  }
  async createSession(userId, { project_id, prompt, agent_id, workflow_name, title,
    model = 'gpt-5', fund = 1, background = false } = {}) {
    await this.ensureProject(userId, project_id);
    let agentId = agent_id, newlyCreatedAgent = null;
    if (!agentId && !workflow_name) throw new Error('agent_id or workflow_name is required');
    if (agentId) {
      const agent = await resolveAgent(userId, agentId, this.db);
      if (!agent?.workflowName) throw new Error('Agent not found or has no workflowName');
      if (workflow_name && workflow_name !== agent.workflowName) throw new Error('Agent workflow mismatch');
      workflow_name = agent.workflowName;
    } else {
      // Same pattern as the new-session UI: create a workflow-backed agent
      // and persist its mapping before launching the workflow.
      newlyCreatedAgent = await createAgentRecord(userId,
        { name: workflow_name, workflowName: workflow_name }, this.db);
      agentId = newlyCreatedAgent.id;
    }
    const sessionId = randomUUID();
    const mapping = await linkAgentSession(userId, project_id, sessionId, agentId, this.db);
    if (!mapping) throw new Error('Unable to link session to agent');
    try {
      const { executionName } = await this.execute({
        userId, projectId: project_id, workflowName: workflow_name,
        params: { query: prompt, sessionId, agentId, model, fund, background },
      });
      return { project_id, session_id: sessionId, agent_id: agentId,
        workflow_name, execution_name: executionName,
        title: title ?? null, status: 'submitted' };
    } catch (error) {
      // Session never launched; discard just-created mapping. Preserve
      // registered agents (as the web UI does) for future reuse.
      await this.db.doc(sessionMapDocPath(userId, project_id, sessionId)).delete().catch(() => {});
      throw error;
    }
  }
  async sendMessage(userId, { project_id, session_id, message, model = 'gpt-5',
    fund = 1, background = false } = {}) {
    await this.ensureProject(userId, project_id);
    const { agentId } = await this.sessionRecord(userId, project_id, session_id);
    if (!agentId) throw new Error('Session has no linked agent');
    const agent = await resolveAgent(userId, agentId, this.db);
    if (!agent?.workflowName) throw new Error('Linked agent or workflow unavailable');
    const { executionName } = await this.execute({
      userId, projectId: project_id, workflowName: agent.workflowName,
      params: { query: message, sessionId: session_id, agentId, model, fund, background },
    });
    return { project_id, session_id, agent_id: agentId, workflow_name: agent.workflowName,
      execution_name: executionName, status: 'submitted' };
  }
  async terminateSession(userId, { project_id, session_id }) {
    const session = await this.getSession(userId, { project_id, session_id });
    const latest = session.latest_execution;
    if (!latest?.execId) throw new Error('Session has no recorded execution to cancel');
    const outcome = await this.cancel({
      userId, projectId: project_id, execId: latest.execId,
      workflow: session.workflow_name || latest.workflow,
      includeDescendants: true,
    });
    if (outcome.status !== 200) throw new Error(outcome.body.error || 'Unable to cancel execution tree');
    return { session_id, project_id, ...outcome.body };
  }
  async searchConversations(userId, { project_id, query, first = 10, after, max_messages = 250 } = {}) {
    const terms = normalizedTerms(query);
    const listings = await this.listSessions(userId, { project_id, first, after });
    const hits = [];
    for (const session of listings.sessions) {
      const transcript = await this.listMessages(userId, {
        project_id, session_id: session.id, first: Math.min(100, max_messages),
      });
      const matches = transcript.messages.map(m => {
        const text = messageText(m).toLowerCase();
        const coverage = terms.filter(t => text.includes(t));
        return { message: m, coverage, excerpt: messageText(m).slice(0, 500) };
      });
      const covered = new Set(matches.flatMap(m => m.coverage));
      if (!terms.every(t => covered.has(t))) continue;
      const ranked = matches.filter(m => m.coverage.length)
        .sort((a, b) => (b.message.role === 'user') - (a.message.role === 'user') ||
          b.coverage.length - a.coverage.length);
      hits.push({ session_id: session.id, title: session.title,
        matching_messages: ranked.length, session_search_complete: !transcript.has_next_page,
        excerpts: ranked.slice(0, 5).map(m => ({ message_id: m.message.id,
          role: m.message.role, create_time: m.message.create_time, text: m.excerpt })) });
    }
    return { project_id, query, sessions: hits, end_cursor: listings.end_cursor,
      has_next_page: listings.has_next_page, search_limitations:
        'Search scans at most the first 100 messages per session; partial transcripts are marked incomplete.' };
  }
  async searchSessionMatches(userId, { project_id, session_id, query, first = 50, after, exclude_message_ids = [] } = {}) {
    const terms = normalizedTerms(query);
    const transcript = await this.listMessages(userId, { project_id, session_id, first, after });
    return { ...transcript, messages: transcript.messages.filter(m => !exclude_message_ids.includes(m.id) &&
      terms.some(t => messageText(m).toLowerCase().includes(t))) };
  }
}
