import { createHash, randomBytes } from 'node:crypto';
import { consumerNames } from './tools.js';
// Defer loading the producer API modules until startup. The same project
// lifecycle is used by both MCP and regular /producer/start requests.
const ensureProjectConsumer = async args => (await import('../jobs/producer/start.js')).ensureProjectConsumer(args);
const getConsumerLock = async args => (await import('../workflows/projects/lock.js')).getConsumerLock(args);
const inspectK8sJob = async args => (await import('../jobs/producer/gke.js')).inspectK8sJob(args);
import { pickBackend, normalizeEnvelope } from '../workflows/events/model.js';

export const digest = value => createHash('sha256').update(value).digest('hex');
export function fail(message) { throw Object.assign(new Error(message), { publicMessage: message }); }
export const validId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

// An MCP workspace is now an attachment to a project consumer, NOT a GKE Job.
// Multiple sessions/clients can share one project environment and consumer lock.
export class ExecutionService {
  constructor({ db, ownerId = process.env.MCP_OWNER_UID, startConsumer = ensureProjectConsumer, getLock = getConsumerLock, backend = pickBackend, inspectJob = inspectK8sJob }) {
    Object.assign(this, { db, ownerId, startConsumer, getLock, backend, inspectJob });
  }
  async isOwner(userId) {
    if (this.ownerId) return userId === this.ownerId;
    if (!userId) return false;
    const snap = await this.db.collection('apiKeys').get();
    const owners = new Set(snap.docs.map(d => d.data()).filter(k =>
      k.expiresAt > Date.now() && Array.isArray(k.scopes) && k.scopes.includes('mcp:invoke')
    ).map(k => k.userId));
    return owners.size === 1 && owners.has(userId);
  }
  ref(id) {
    if (!validId(id)) fail('Invalid workspace ID');
    return this.db.collection('mcpWorkspaces').doc(id);
  }
  async owned(userId, id, { allowStopped = false } = {}) {
    const snap = await this.ref(id).get();
    const ws = snap.data();
    if (!snap.exists || ws.userId !== userId) fail('Workspace not found');
    if (!allowStopped && (ws.stopped || ws.expiresAt <= Date.now())) fail('Workspace stopped or expired');
    return ws;
  }
  async status(userId, ws) {
    const { lock } = await this.getLock({ userId, projectId: ws.projectId });
    const leaseActive = Boolean(lock && lock.expiresAt > Date.now());
    const runtime = lock?.runtime;
    const job = leaseActive && runtime?.mode === 'gke' && runtime.consumerJobName
      ? await this.inspectJob({
        namespace: runtime.namespace || process.env.K8S_NAMESPACE || 'awfl',
        jobName: runtime.consumerJobName,
      }) : null;
    const running = leaseActive && job?.state !== 'failed' && job?.state !== 'not_found';
    return {
      state: running ? 'attached' : 'consumer_unavailable',
      project_id: ws.projectId, session_id: ws.sessionId,
      consumer_id: leaseActive ? lock.consumerId : null,
      shared: true,
      ...(job ? { consumer_job: job } : {}),
    };
  }
  async invoke(userId, name, args = {}) {
    if (!await this.isOwner(userId)) fail('Owner access required');
    if (name === 'environment_status' && !args.workspace_id) return {
      state: 'control_plane_ready', transport: 'Shared project event stream and callbacks',
      execution: 'Existing project-scoped consumer; one GKE Job/lock per project',
      configured: true,
    };
    if (name === 'workspace_create') return this.create(userId, args);
    const ws = await this.owned(userId, args.workspace_id, { allowStopped: name === 'workspace_stop' });
    if (name === 'workspace_stop') {
      // Detach only. The consumer is shared with other clients/sessions.
      await this.ref(args.workspace_id).update({ stopped: true });
      return { workspace_id: args.workspace_id, state: 'detached', consumer_stopped: false };
    }
    if (name === 'environment_status') return this.status(userId, ws);
    if (name === 'request_result') {
      const snap = await this.ref(args.workspace_id).collection('mcpRequests').doc(String(args.request_id).padStart(8, '0')).get();
      if (!snap.exists) fail('Request not found');
      const request = snap.data() || {};
      // Keep the existing pending protocol while exposing the persisted lifecycle.
      // This distinguishes an undelivered/unclaimed request from an executing one.
      return request.result ?? {
        state: 'pending',
        request_id: args.request_id,
        request_state: request.state || 'unknown',
        created_at: request.createdAt ?? null,
        claimed_at: request.claimedAt ?? null,
      };
    }
    if (!consumerNames[name]) fail('Unsupported MCP tool');

    // The normal project consumer receives these events. It is the only
    // executor, regardless of whether the caller is a browser, CLI, or MCP.
    const { lock } = await this.getLock({ userId, projectId: ws.projectId });
    if (!lock || lock.expiresAt <= Date.now()) fail('Project consumer not running; reattach workspace to start it');
    const ref = this.ref(args.workspace_id);
    const seq = await this.db.runTransaction(async tx => {
      const fresh = (await tx.get(ref)).data();
      if (fresh.stopped || fresh.expiresAt <= Date.now()) fail('Workspace stopped or expired');
      if (fresh.nextSeq >= 2000) fail('Workspace request limit reached');
      const next = fresh.nextSeq + 1;
      const { workspace_id, ...parameters } = args;
      tx.update(ref, { nextSeq: next });
      tx.create(ref.collection('mcpRequests').doc(String(next).padStart(8, '0')), {
        seq: next, state: 'queued', toolName: name, createdAt: Date.now(),
        expires_at: new Date(ws.expiresAt + 86400000),
        args: parameters,
      });
      return next;
    });
    const request = ref.collection('mcpRequests').doc(String(seq).padStart(8, '0'));
    const { workspace_id, ...parameters } = args;
    // MCP is a client of the *normal* AWFL tool protocol. In particular, the
    // existing Python handle_response() executes tool_call and posts callback_id.
    // There is no separate MCP executor, command runtime, or SSE event type.
    const callbackId = randomBytes(16).toString('hex');
    const callback = this.db.collection('users').doc(userId).collection('callbacks').doc(callbackId);
    await callback.set({
      kind: 'mcp_request',
      mcp: { projectId: ws.projectId, workspaceId: workspace_id, requestId: seq },
      created_at: Date.now(),
      expires_at: new Date(ws.expiresAt + 86400000),
    });
    const toolArgs = name === 'run_command'
      ? { command: parameters.command }
      : name === 'read_file'
        ? { filepath: parameters.path }
        : { filepath: parameters.path, content: parameters.content };
    const eventData = {
      callback_id: callbackId,
      tool_call: { function: { name: consumerNames[name], arguments: toolArgs } },
    };
    if (name === 'run_command') {
      eventData.timeout_seconds = parameters.timeout ?? 120;
      if (parameters.cwd) eventData.workdir = parameters.cwd;
    }
    try {
      await this.backend(userId, ws.projectId).append(normalizeEnvelope({
        projectId: ws.projectId, sessionId: ws.sessionId,
        type: 'message', source: 'mcp', data: eventData,
      }));
    } catch (e) {
      await request.update({ state: 'delivery_failed', result: { error: 'MCP command could not be delivered' } });
      await callback.delete?.().catch(() => {});
      fail('MCP command could not be delivered');
    }
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      const timer = setTimeout(() => {
        unsubscribe();
        resolve({ state: 'pending', request_id: seq, workspace_id: args.workspace_id,
          message: 'Command not acknowledged within 15s; use request_result (do not repeat side effects).' });
      }, 15000);
      unsubscribe = request.onSnapshot(snap => {
        if (snap.data()?.result !== undefined) {
          clearTimeout(timer); unsubscribe(); resolve(snap.data().result);
        }
      }, () => {
        clearTimeout(timer); unsubscribe(); reject(new Error('Response unavailable'));
      });
    });
  }
  async create(userId, args = {}) {
    // Do not silently select a random project as the earlier MCP implementation did.
    const projectId = typeof args.project_id === 'string' ? args.project_id.trim() : '';
    if (!projectId) fail('project_id is required');
    const project = await this.db.collection('users').doc(userId).collection('projects').doc(projectId).get();
    if (!project.exists) fail('Project not found');
    const consumer = await this.startConsumer({ userId, projectId });
    const id = randomBytes(16).toString('hex');
    const sessionId = (typeof args.session_id === 'string' && args.session_id.trim()) || 'mcp-' + id;
    const expiresAt = Date.now() + 3600000;
    await this.ref(id).set({
      userId, projectId, sessionId, nextSeq: 0, expiresAt,
      expires_at: new Date(expiresAt + 86400000), stopped: false,
    });
    return { workspace_id: id, project_id: projectId, session_id: sessionId,
      state: consumer.state, consumer_id: consumer.consumerId,
      shared: true, expires_at: expiresAt };
  }
  async complete(userId, projectId, id, seq, result) {
    const ws = await this.owned(userId, id);
    if (ws.projectId !== projectId) fail('Project mismatch');
    const request = this.ref(id).collection('mcpRequests').doc(String(seq).padStart(8, '0'));
    const done = await this.db.runTransaction(async tx => {
      const snap = await tx.get(request);
      if (!snap.exists || !['queued', 'running'].includes(snap.data().state)) return null;
      tx.update(request, { state: 'completed', result, completedAt: Date.now() });
      return snap.data().toolName;
    });
    if (done) {
      // Session-scoped history uses the same relay as every other AWFL client.
      // Do not persist raw command output or credentials in the conversation.
      await this.backend(userId, projectId).append(normalizeEnvelope({
        projectId, sessionId: ws.sessionId, type: 'message', source: 'mcp',
        data: { mcp: { workspace_id: id, request_id: seq },
          content: 'MCP ' + done + ' ' + (result?.error ? 'failed' : 'completed'),
          exit_code: result?.exitCode ?? null },
      })).catch(() => {});
    }
    return { ok: Boolean(done) };
  }
}
