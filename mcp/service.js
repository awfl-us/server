import { createHash, randomBytes } from 'node:crypto';
import { consumerNames } from './tools.js';
// Defer loading the producer API modules until startup. The same project
// lifecycle is used by both MCP and regular /producer/start requests.
const ensureProjectConsumer = async args => (await import('../jobs/producer/start.js')).ensureProjectConsumer(args);
const stopProjectConsumer = async args => (await import('../jobs/producer/stop.js')).stopProjectConsumer(args);
const getConsumerLock = async args => (await import('../workflows/projects/lock.js')).getConsumerLock(args);
const inspectK8sJob = async args => (await import('../jobs/producer/gke.js')).inspectK8sJob(args);
import { pickBackend, normalizeEnvelope } from '../workflows/events/model.js';

export const digest = value => createHash('sha256').update(value).digest('hex');
export function fail(message) { throw Object.assign(new Error(message), { publicMessage: message }); }
export const validId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const requestDocId = seq => String(seq).padStart(8, '0');
// 32 hexadecimal characters keep compatibility with existing AWFL MCP
// connectors. The first 24 are the workspace prefix; the final eight
// encode the per-workspace sequence. Authorization always checks the FULL
// workspace ID separately. Previous exec_<workspace>_<seq> handles remain
// readable across the upgrade.
export const executionIdFor = (workspaceId, seq) =>
  workspaceId.slice(0, 24) + seq.toString(16).padStart(8, '0');
export function parseExecutionId(id, workspaceId) {
  if (!validId(workspaceId)) fail('Invalid workspace ID');
  const raw = String(id || '');
  const oldId = /^exec_([a-f0-9]{32})_([0-9]{8})$/.exec(raw);
  if (oldId) {
    if (oldId[1] !== workspaceId) fail('Execution belongs to another workspace');
    return { workspaceId, seq: Number(oldId[2]) };
  }
  if (!/^[a-f0-9]{32}$/.test(raw) || raw.slice(0, 24) !== workspaceId.slice(0, 24)) {
    fail('Invalid execution ID for workspace');
  }
  const seq = Number.parseInt(raw.slice(24), 16);
  if (!Number.isSafeInteger(seq) || seq < 1 || seq > 2000) fail('Invalid execution ID sequence');
  return { workspaceId, seq };
}
const terminalStates = new Set(['completed', 'failed', 'timed_out', 'cancelled']);
function requestState(data) {
  if (data?.result !== undefined) {
    return data.result?.state || (data.result?.timed_out ? 'timed_out' : 'completed');
  }
  return data?.state || 'queued';
}
function commandArguments(args) {
  const fields = ['command', 'cwd', 'timeout', 'timeout_ms', 'interactive', 'pty', 'rows', 'cols', 'session_id'];
  return Object.fromEntries(fields.filter(k => args[k] !== undefined).map(k => [k, args[k]]));
}


// An MCP workspace is now an attachment to a project consumer, NOT a GKE Job.
// Multiple sessions/clients can share one project environment and consumer lock.
export class ExecutionService {
  constructor({ db, ownerId = process.env.MCP_OWNER_UID, startConsumer = ensureProjectConsumer, stopConsumer = stopProjectConsumer, getLock = getConsumerLock, backend = pickBackend, inspectJob = inspectK8sJob }) {
    Object.assign(this, { db, ownerId, startConsumer, stopConsumer, getLock, backend, inspectJob });
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
  async status(userId, ws, workspaceId = null) {
    const { lock } = await this.getLock({ userId, projectId: ws.projectId });
    const leaseActive = Boolean(lock && lock.expiresAt > Date.now());
    const runtime = lock?.runtime;
    const job = leaseActive && runtime?.mode === 'gke' && runtime.consumerJobName
      ? await this.inspectJob({
        namespace: runtime.namespace || process.env.K8S_NAMESPACE || 'awfl',
        jobName: runtime.consumerJobName,
      }) : null;
    const running = leaseActive && job?.state !== 'failed' && job?.state !== 'not_found';
    const heartbeat = lock?.heartbeat;
    const heartbeatFresh = Boolean(heartbeat && heartbeat.consumerId === lock.consumerId &&
      heartbeat.generation === lock.acquiredAt &&
      Number.isFinite(heartbeat.at) && Date.now() - heartbeat.at < 30000);
    const ready = running && heartbeatFresh && heartbeat.connected === true;
    let pending = null, active = null;
    if (workspaceId) {
      try {
        const requests = this.ref(workspaceId).collection('mcpRequests');
        const [queued, executing] = await Promise.all([
          requests.where('state', 'in', ['accepted', 'queued', 'waiting_for_consumer']).count().get(),
          requests.where('state', '==', 'running').count().get(),
        ]);
        pending = queued.data().count;
        active = executing.data().count;
      } catch {
        // Status remains available when optional count aggregation is unavailable.
      }
    }
    return {
      state: !running ? 'consumer_unavailable' : ready ? 'attached' : 'starting',
      project_id: ws.projectId, session_id: ws.sessionId,
      consumer_id: leaseActive ? lock.consumerId : null,
      consumer: {
        id: leaseActive ? lock.consumerId : null,
        job_state: job?.state || 'unknown',
        readiness: ready ? 'ready' : running ? 'initializing' : 'unavailable',
        connected: ready,
        last_heartbeat_at: heartbeatFresh ? heartbeat.at : null,
        startup_phase: ready ? 'ready' : job?.state === 'pending' ? 'provisioning' : 'initializing',
        capacity: heartbeatFresh ? heartbeat.capacity : null,
        active_execution_ids: heartbeatFresh ? heartbeat.activeExecutions : [],
        capabilities: heartbeatFresh ? heartbeat.capabilities : [],
      },
      shared: true,
      queue: { pending, running: active },
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
    if (name === 'projects_list') return this.listProjects(userId, args);
    if (name === 'workspace_create') return this.create(userId, args);
    const ws = await this.owned(userId, args.workspace_id, { allowStopped: name === 'workspace_stop' });
    if (name === 'workspace_stop') {
      if (args.confirm !== true) fail('Confirm stopping the shared project consumer');
      // Idempotent: never let a stopped workspace shut down a later consumer.
      if (ws.stopped) return { workspace_id: args.workspace_id, state: 'stopped',
        consumer_stopped: false, shared: true };
      // Use exactly the same shutdown + lock release sequence as /producer/stop.
      // The consumer is shared: this intentionally interrupts other clients.
      const outcome = await this.stopConsumer({ userId, projectId: ws.projectId });
      if (!outcome?.body?.ok || outcome.status >= 300) {
        fail(outcome?.body?.error || 'Project consumer stop failed; project lock retained');
      }
      // Only retire this MCP attachment AFTER the shared shutdown succeeded.
      await this.ref(args.workspace_id).update({ stopped: true });
      return { workspace_id: args.workspace_id, state: 'stopped',
        consumer_stopped: Boolean(outcome.body.consumerStopped), shared: true };
    }
    if (name === 'environment_status') return this.status(userId, ws, args.workspace_id);
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
    if (name === 'command_output') return this.commandOutput(userId, ws, args);
    if (!consumerNames[name]) fail('Unsupported MCP tool');
    return this.submit(userId, name, args, ws);
  }

  async submit(userId, name, args, ws) {
    const isCommand = name === 'run_command';
    const workspaceId = args.workspace_id;
    const ref = this.ref(workspaceId);
    const { lock } = await this.getLock({ userId, projectId: ws.projectId });
    const consumerLive = Boolean(lock && lock.expiresAt > Date.now());
    // A valid workspace already attached to a starting consumer can accept
    // commands immediately. The existing project SSE will deliver them when
    // that consumer subscribes; GKE startup is not a command timeout.
    if (!consumerLive && !isCommand) fail('Project consumer not running; reattach workspace to start it');

    const parameters = Object.fromEntries(Object.entries(args).filter(([k]) =>
      !['workspace_id', 'idempotency_key', 'yield_time_ms', 'max_output_bytes'].includes(k)));
    const fingerprint = isCommand ? digest(JSON.stringify(commandArguments(args))) : null;
    const key = isCommand && args.idempotency_key ? digest(args.idempotency_key) : null;
    const keyRef = key
      ? this.db.collection('users').doc(userId).collection('projects').doc(ws.projectId)
        .collection('mcpCommandKeys').doc(key)
      : null;
    const transaction = await this.db.runTransaction(async tx => {
      const freshSnap = await tx.get(ref);
      const fresh = freshSnap.data();
      if (!fresh || fresh.stopped || fresh.expiresAt <= Date.now()) fail('Workspace stopped or expired');
      const existing = keyRef ? await tx.get(keyRef) : null;
      if (existing?.exists) {
        const bound = existing.data();
        if (bound.fingerprint !== fingerprint) fail('Idempotency key conflicts with different command arguments');
        return { seq: bound.seq, workspaceId: bound.workspaceId, created: false };
      }
      if (fresh.nextSeq >= 2000) fail('Workspace request limit reached');
      const seq = fresh.nextSeq + 1;
      const expires_at = new Date(fresh.expiresAt + 86400000);
      const id = executionIdFor(workspaceId, seq);
      tx.update(ref, { nextSeq: seq });
      tx.create(ref.collection('mcpRequests').doc(requestDocId(seq)), {
        seq, executionId: id, state: consumerLive ? 'queued' : 'waiting_for_consumer',
        toolName: name, createdAt: Date.now(), claimedAt: null, outputCursor: 0,
        startupDeadlineAt: Date.now() + 180000,
        expires_at, args: parameters,
      });
      if (keyRef) tx.create(keyRef, { workspaceId, seq, fingerprint, createdAt: Date.now(), expires_at });
      return { seq, workspaceId, created: true };
    });

    const existingWs = transaction.workspaceId === workspaceId
      ? ws : await this.owned(userId, transaction.workspaceId);
    const id = executionIdFor(transaction.workspaceId, transaction.seq);
    if (!transaction.created) {
      if (isCommand) return this.waitForCommand(userId, existingWs, {
        workspace_id: transaction.workspaceId, execution_id: id,
        yield_time_ms: args.yield_time_ms ?? 10000,
        max_output_bytes: args.max_output_bytes ?? 65536,
      });
      const previous = await this.ref(transaction.workspaceId).collection('mcpRequests')
        .doc(requestDocId(transaction.seq)).get();
      return previous.data()?.result ?? { state: previous.data()?.state || 'queued' };
    }

    const request = ref.collection('mcpRequests').doc(requestDocId(transaction.seq));
    const callbackId = randomBytes(16).toString('hex');
    const callback = this.db.collection('users').doc(userId).collection('callbacks').doc(callbackId);
    await callback.set({
      kind: 'mcp_request',
      mcp: { projectId: ws.projectId, workspaceId, requestId: transaction.seq },
      created_at: Date.now(),
      expires_at: new Date(ws.expiresAt + 86400000),
    });
    await request.update({ callbackId });
    let toolArgs;
    if (name === 'run_command') {
      toolArgs = commandArguments(args);
    } else if (name === 'read_file' || name === 'write_file') {
      const { path, ...rest } = parameters;
      toolArgs = { filepath: path, ...rest };
    } else {
      toolArgs = parameters;
    }
    const eventData = {
      callback_id: callbackId,
      mcp: { execution_id: id, request_id: transaction.seq },
      tool_call: { function: { name: consumerNames[name], arguments: toolArgs } },
    };
    if (name === 'run_command') {
      eventData.timeout_seconds = args.timeout_ms ? args.timeout_ms / 1000 : args.timeout ?? 120;
      if (args.cwd) eventData.workdir = args.cwd;
    }
    try {
      if (isCommand && !consumerLive) {
        // Reuse the project's existing lifecycle. Startup is separate from
        // the command execution timeout; no second GKE Job/consumer is created.
        await this.startConsumer({ userId, projectId: ws.projectId });
      }
      await this.backend(userId, ws.projectId).append(normalizeEnvelope({
        projectId: ws.projectId, sessionId: ws.sessionId,
        type: 'message', source: 'mcp', data: eventData,
      }));
      const current = await this.getLock({ userId, projectId: ws.projectId });
      await request.update({ dispatchedAt: Date.now(),
        dispatchConsumerId: current.lock?.consumerId || null });
    } catch {
      await request.update({
        state: 'failed', result: {
          execution_id: id, state: 'failed', exit_code: null,
          error: { code: 'consumer_unavailable', message: 'Command delivery failed', retryable: true },
        },
      });
      await callback.delete?.().catch(() => {});
      if (!isCommand) fail('MCP command could not be delivered');
    }
    if (isCommand) {
      return this.waitForCommand(userId, ws, {
        workspace_id: workspaceId, execution_id: id,
        yield_time_ms: args.yield_time_ms ?? 10000,
        max_output_bytes: args.max_output_bytes ?? 65536,
        consumer: { state: consumerLive ? 'active' : 'starting' },
      });
    }
    // Existing file-tool compatibility: wait for the callback, or return a
    // recoverable request handle if the consumer is still busy.
    return new Promise(resolve => {
      let unsubscribe = () => {};
      const timer = setTimeout(() => {
        unsubscribe();
        resolve({ state: 'pending', request_id: transaction.seq, workspace_id: workspaceId,
          message: 'Request is queued; use request_result without resubmitting.' });
      }, 15000);
      unsubscribe = request.onSnapshot(snap => {
        if (snap.data()?.result !== undefined) {
          clearTimeout(timer); unsubscribe(); resolve(snap.data().result);
        }
      }, () => {
        clearTimeout(timer); unsubscribe();
        resolve({ state: 'pending', request_id: transaction.seq, workspace_id: workspaceId });
      });
    });
  }

  async waitForCommand(userId, ws, args) {
    const parsed = parseExecutionId(args.execution_id, args.workspace_id);
    const request = this.ref(parsed.workspaceId).collection('mcpRequests').doc(requestDocId(parsed.seq));
    const wait = Math.max(0, Math.min(15000, args.yield_time_ms ?? 10000));
    if (wait) await new Promise(resolve => {
      let unsubscribe = () => {};
      const timer = setTimeout(() => { unsubscribe(); resolve(); }, wait);
      unsubscribe = request.onSnapshot(snap => {
        if (snap.data()?.result !== undefined) {
          clearTimeout(timer); unsubscribe(); resolve();
        }
      }, () => { clearTimeout(timer); unsubscribe(); resolve(); });
    });
    return this.commandOutput(userId, ws, { workspace_id: parsed.workspaceId,
      execution_id: args.execution_id, cursor: 0, max_bytes: args.max_output_bytes ?? 65536,
      wait_ms: 0, consumer: args.consumer });
  }

  async reconcileExecution(userId, ws, request, data) {
    if (!data || terminalStates.has(requestState(data))) return;
    const { lock } = await this.getLock({ userId, projectId: ws.projectId });
    const live = Boolean(lock && lock.expiresAt > Date.now());
    if (data.state === 'running') {
      let lost = !live || (data.claimedBy && lock.consumerId !== data.claimedBy);
      if (!lost && lock.runtime?.consumerJobName) {
        const job = await this.inspectJob({
          namespace: lock.runtime.namespace || process.env.K8S_NAMESPACE || 'awfl',
          jobName: lock.runtime.consumerJobName,
        });
        lost = job.state === 'failed' || job.state === 'not_found';
      }
      if (lost) {
        await this.db.runTransaction(async tx => {
          const snapshot = await tx.get(request);
          if (snapshot.exists && snapshot.data().state === 'running') {
            tx.update(request, { state: 'failed', completedAt: Date.now(),
              result: { execution_id: data.executionId, state: 'failed',
                exit_code: null, error: { code: 'execution_lost',
                  message: 'Consumer ended after claiming this execution; it will not be replayed',
                  retryable: false } } });
          }
        });
      }
      return;
    }
    if (!['queued', 'waiting_for_consumer', 'accepted'].includes(data.state)) return;
    if (Date.now() >= (data.startupDeadlineAt || data.createdAt + 180000)) {
      await this.db.runTransaction(async tx => {
        const snapshot = await tx.get(request);
        if (snapshot.exists && ['queued', 'waiting_for_consumer', 'accepted'].includes(snapshot.data().state)) {
          tx.update(request, { state: 'failed', completedAt: Date.now(),
            result: { execution_id: data.executionId, state: 'failed', exit_code: null,
              error: { code: 'consumer_start_timeout',
                message: 'Consumer did not claim the command before the startup deadline',
                retryable: true } } });
        }
      });
      return;
    }
    if (!live || data.dispatchConsumerId === lock.consumerId || !data.callbackId) return;
    // A queued/unclaimed command can safely be re-delivered to a replacement
    // generation; the transactional claim prevents duplicate side effects.
    const eligible = await this.db.runTransaction(async tx => {
      const snapshot = await tx.get(request);
      if (!snapshot.exists || !['queued', 'waiting_for_consumer', 'accepted'].includes(snapshot.data().state) ||
          snapshot.data().dispatchConsumerId === lock.consumerId) return false;
      tx.update(request, { state: 'queued', dispatchConsumerId: lock.consumerId,
        dispatchedAt: Date.now() });
      return true;
    });
    if (!eligible) return;
    const original = data.args || {};
    const toolName = data.toolName;
    const args = toolName === 'run_command' ? commandArguments(original) : original;
    const eventData = {
      callback_id: data.callbackId,
      mcp: { execution_id: data.executionId, request_id: data.seq },
      tool_call: { function: { name: consumerNames[toolName], arguments: args } },
    };
    if (toolName === 'run_command') {
      eventData.timeout_seconds = original.timeout_ms ? original.timeout_ms / 1000 : original.timeout ?? 120;
      if (original.cwd) eventData.workdir = original.cwd;
    }
    try {
      await this.backend(userId, ws.projectId).append(normalizeEnvelope({
        projectId: ws.projectId, sessionId: ws.sessionId,
        type: 'message', source: 'mcp', data: eventData,
      }));
    } catch {
      await request.update({ dispatchConsumerId: null });
    }
  }

  async commandOutput(userId, ws, args) {
    const { workspaceId, seq } = parseExecutionId(args.execution_id, args.workspace_id);
    if (workspaceId !== args.workspace_id) fail('Execution belongs to another workspace');
    const target = await this.owned(userId, workspaceId);
    if (target.projectId !== ws.projectId) fail('Execution belongs to another project');
    const request = this.ref(workspaceId).collection('mcpRequests').doc(requestDocId(seq));
    let snap = await request.get();
    if (!snap.exists || snap.data()?.toolName !== 'run_command') fail('Execution not found');
    await this.reconcileExecution(userId, target, request, snap.data());
    snap = await request.get();
    const cursor = args.cursor ?? 0;
    const maxBytes = args.max_bytes ?? 65536;
    if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(maxBytes) || maxBytes < 1) fail('Invalid cursor or max_bytes');
    const wait = Math.min(Math.max(0, args.wait_ms ?? 0), 15000);
    if (wait && (snap.data()?.outputCursor || 0) <= cursor && !terminalStates.has(requestState(snap.data()))) {
      await new Promise(resolve => {
        let unsubscribe = () => {};
        const timer = setTimeout(() => { unsubscribe(); resolve(); }, wait);
        unsubscribe = request.onSnapshot(s => {
          if ((s.data()?.outputCursor || 0) > cursor || terminalStates.has(requestState(s.data()))) {
            clearTimeout(timer); unsubscribe(); resolve();
          }
        }, () => { clearTimeout(timer); unsubscribe(); resolve(); });
      });
      snap = await request.get();
    }
    const data = snap.data();
    const high = data.outputCursor || 0;
    if (cursor > high) fail('Invalid output cursor');
    const chunks = [];
    let nextCursor = cursor, used = 0;
    for (let index = cursor + 1; index <= high && chunks.length < 128; index++) {
      const piece = await request.collection('output').doc(requestDocId(index)).get();
      if (!piece.exists) break;
      const event = piece.data();
      const bytes = Buffer.byteLength(event.text || '', 'utf8');
      if (used + bytes > maxBytes) break;
      chunks.push({ cursor: index, stream: event.stream, text: event.text });
      used += bytes;
      nextCursor = index;
    }
    const complete = terminalStates.has(requestState(data));
    if (complete && nextCursor < high && chunks.length === 0) {
      return { execution_id: args.execution_id, state: 'failed', exit_code: null,
        cursor, has_more: false, error: {
          code: 'output_expired', message: 'Persisted output is incomplete or max_bytes too small',
          retryable: false,
        } };
    }
    const result = data.result || {};
    // Compatibility with older CLI versions, which only returned final output.
    const fallback = high === 0 ? (result.output || '') : '';
    const state = complete ? requestState(data) : (data.claimedAt ? 'running' : data.state || 'queued');
    return {
      execution_id: args.execution_id, workspace_id: workspaceId,
      state, exit_code: result.exit_code ?? result.exitCode ?? null,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      stdout: chunks.filter(x => x.stream === 'stdout' || x.stream === 'pty').map(x => x.text).join('') || fallback,
      stderr: chunks.filter(x => x.stream === 'stderr').map(x => x.text).join(''),
      chunks, cursor: nextCursor, has_more: nextCursor < high,
      truncated: Boolean(result.truncated), cwd: result.cwd || data.args?.cwd || '/workspace',
      error: result.error && typeof result.error === 'object' ? result.error : null,
      ...(fallback ? { output: fallback } : {}),
      ...(args.consumer && !data.claimedAt ? { consumer: args.consumer } : {}),
      ...(result.output_incomplete ? { output_incomplete: true } : {}),
    };
  }

  async claim(userId, projectId, workspaceId, seq, consumerId) {
    const ws = await this.owned(userId, workspaceId);
    if (ws.projectId !== projectId) fail('Project mismatch');
    const { lock } = await this.getLock({ userId, projectId });
    if (!consumerId || !lock || lock.consumerId !== consumerId || lock.expiresAt <= Date.now()) {
      return { ok: false, claimed: false };
    }
    const request = this.ref(workspaceId).collection('mcpRequests').doc(requestDocId(seq));
    return this.db.runTransaction(async tx => {
      const snap = await tx.get(request);
      if (!snap.exists || !['queued', 'waiting_for_consumer', 'accepted'].includes(snap.data().state)) {
        return { ok: false, claimed: false };
      }
      tx.update(request, { state: 'running', claimedAt: Date.now(), claimedBy: consumerId });
      return { ok: true, claimed: true };
    });
  }

  async progress(userId, projectId, workspaceId, seq, payload) {
    const ws = await this.owned(userId, workspaceId);
    if (ws.projectId !== projectId) fail('Project mismatch');
    const chunk = payload.chunk || {};
    const index = chunk.cursor;
    if (!Number.isInteger(index) || index < 1 || index > 100000 ||
        !['stdout', 'stderr', 'pty'].includes(chunk.stream) ||
        typeof chunk.text !== 'string' || Buffer.byteLength(chunk.text) > 65536) {
      fail('Invalid output event');
    }
    const request = this.ref(workspaceId).collection('mcpRequests').doc(requestDocId(seq));
    return this.db.runTransaction(async tx => {
      const snap = await tx.get(request);
      if (!snap.exists || snap.data().state !== 'running' ||
          snap.data().executionId !== payload.execution_id) return { ok: false };
      const high = snap.data().outputCursor || 0;
      if (index <= high) return { ok: true, duplicate: true };
      if (index !== high + 1) return { ok: false, error: 'Output cursor gap' };
      tx.create(request.collection('output').doc(requestDocId(index)), {
        stream: chunk.stream, text: chunk.text, cursor: index,
        timestamp: Date.now(), expires_at: snap.data().expires_at,
      });
      tx.update(request, { outputCursor: index, lastOutputAt: Date.now() });
      return { ok: true };
    });
  }

  async listProjects(userId, { limit = 50 } = {}) {
    // Project records are already scoped to the authenticated owner. Sort in
    // memory to support older records without an 'updated' field or new indexes.
    const snap = await this.db.collection('users').doc(userId).collection('projects').get();
    const timestamp = value => {
      if (typeof value === 'number') return value;
      if (value?.toMillis) return value.toMillis();
      if (typeof value === 'string') return Date.parse(value) || 0;
      return 0;
    };
    const projects = snap.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        name: data.name || null,
        remote: data.remote || null,
        updated: data.updated ?? null,
        created: data.created ?? null,
      };
    }).sort((a, b) =>
      (timestamp(b.updated) || timestamp(b.created)) -
      (timestamp(a.updated) || timestamp(a.created))
    ).slice(0, Math.min(Math.max(1, limit), 200));
    return { projects };
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
      const toolName = snap.data().toolName;
      // The normal READ_FILE callback names its result field "content".
      // Keep that callback unchanged, but do not return a nested "content"
      // field from MCP: MCP itself uses content for its response blocks.
      // Use "text" for the file contents at the MCP boundary.
      let response = result;
      if (toolName === 'read_file' && typeof result?.content === 'string') {
        const { content, ...rest } = result;
        response = { ...rest, text: content };
      }
      const terminal = ['completed', 'failed', 'timed_out', 'cancelled'].includes(response?.state)
        ? response.state : 'completed';
      tx.update(request, { state: terminal, result: response, completedAt: Date.now() });
      return toolName;
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
