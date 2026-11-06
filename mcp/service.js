import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { consumerNames } from './tools.js';

export const digest = value => createHash('sha256').update(value).digest('hex');
export function fail(message) { throw Object.assign(new Error(message), { publicMessage: message }); }
export const validId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

export class ExecutionService {
  constructor({ db, runtime, ownerId = process.env.MCP_OWNER_UID, origin = process.env.API_ORIGIN }) {
    Object.assign(this, { db, runtime, ownerId, origin });
  }
  ref(id) { if (!validId(id)) fail('Invalid workspace ID'); return this.db.collection('mcpWorkspaces').doc(id); }
  async owned(userId, id, { allowStopped = false } = {}) {
    const snap = await this.ref(id).get();
    const ws = snap.data();
    if (!snap.exists || ws.userId !== userId) fail('Workspace not found');
    if (!allowStopped && (ws.stopped || ws.expiresAt <= Date.now())) fail('Workspace stopped or expired');
    return ws;
  }
  async consumer(id, token) {
    if (!validId(id) || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const snap = await this.ref(id).get();
    const ws = snap.data();
    if (!ws || ws.stopped || ws.expiresAt <= Date.now()) return null;
    if (!timingSafeEqual(Buffer.from(digest(token), 'hex'), Buffer.from(ws.capabilityHash, 'hex'))) return null;
    return ws;
  }
  async invoke(userId, name, args) {
    if (!this.ownerId || userId !== this.ownerId) fail('Owner access required');
    if (name === 'environment_status' && !args.workspace_id) return {
      state: 'control_plane_ready', transport: 'SSE tool calls to Python AWFL consumer; HTTP callbacks',
      execution: 'isolated GKE Job with one-hour lifetime', limits: { workspaces: 1, concurrent_commands: 4, command_seconds: 900 },
      configured: this.runtime.configured(), connectivity: 'Use workspace environment_status and run_command to verify live connectivity',
    };
    if (name === 'workspace_create') return this.create(userId);
    const ws = await this.owned(userId, args.workspace_id, { allowStopped: name === 'workspace_stop' });
    if (name === 'request_result') {
      const snap = await this.ref(args.workspace_id).collection('mcpRequests').doc(String(args.request_id).padStart(8, '0')).get();
      if (!snap.exists) fail('Request not found');
      return snap.data().result ?? { state: 'pending', request_id: args.request_id };
    }
    if (name === 'workspace_stop') {
      await this.ref(args.workspace_id).update({ stopped: true }); // revoke capability before deleting pod
      await this.runtime.stop(ws.jobName);
      return { workspace_id: args.workspace_id, state: 'stopped' };
    }
    const ref = this.ref(args.workspace_id);
    const seq = await this.db.runTransaction(async tx => {
      const fresh = (await tx.get(ref)).data();
      if (fresh.stopped || fresh.expiresAt <= Date.now()) fail('Workspace stopped or expired');
      if (fresh.nextSeq >= 2000) fail('Workspace request limit reached; stop and recreate');
      if (fresh.nextSeq - (fresh.ackSeq || 0) >= 8) fail('Consumer queue full or not ready; retry after startup');
      const next = fresh.nextSeq + 1;
      const { workspace_id, ...parameters } = args;
      tx.update(ref, { nextSeq: next });
      tx.create(ref.collection('mcpRequests').doc(String(next).padStart(8, '0')), {
        seq: next, expires_at: new Date(ws.expiresAt + 86400000),
        data: { callback_id: String(next), tool_call: { function: { name: consumerNames[name], arguments: parameters } } },
      });
      return next;
    });
    const responseRef = ref.collection('mcpRequests').doc(String(seq).padStart(8, '0'));
    // Bounded request; execution itself remains in the consumer after this HTTP response.
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      const timer = setTimeout(() => { unsubscribe(); resolve({ state: 'pending', request_id: seq,
        workspace_id: args.workspace_id, error: 'Consumer has not acknowledged in 15s. Use request_result with request_id; do not retry a mutating call blindly.' }); }, 15000);
      unsubscribe = responseRef.onSnapshot(snap => {
        if (snap.data()?.result !== undefined) { clearTimeout(timer); unsubscribe(); resolve(snap.data().result); }
      }, () => { clearTimeout(timer); unsubscribe(); reject(new Error('Response unavailable')); });
    });
  }
  async create(userId) {
    if (!this.runtime.configured()) fail('Cloud execution is not configured');
    const id = randomBytes(16).toString('hex');
    const token = randomBytes(32).toString('base64url');
    const ref = this.ref(id);
    const slot = this.db.collection('mcpOwners').doc(digest(userId));
    const expiresAt = Date.now() + 3600000;
    const result = await this.db.runTransaction(async tx => {
      const current = (await tx.get(slot)).data();
      if (current?.id) {
        const existing = (await tx.get(this.ref(current.id))).data();
        if (existing && !existing.stopped && existing.expiresAt > Date.now()) return { workspace_id: current.id, state: existing.state, expires_at: existing.expiresAt, attached: true };
      }
      tx.set(slot, { id });
      tx.create(ref, { userId, jobName: `mcp-${id}`, capabilityHash: digest(token), expiresAt,
        expires_at: new Date(expiresAt + 86400000), nextSeq: 0, ackSeq: 0, stopped: false, state: 'starting' });
      return null;
    });
    if (result) return result;
    try {
      await this.runtime.start({ id, token, expiresAt, origin: this.origin });
      return { workspace_id: id, state: 'starting', expires_at: expiresAt, cwd: '/workspace' };
    } catch {
      await ref.update({ stopped: true, state: 'failed' });
      // Deletion is idempotent, including an uncertain create response.
      await this.runtime.stop(`mcp-${id}`).catch(() => {});
      fail('Cloud workspace could not start; inspect deployment permissions and GKE configuration');
    }
  }
}
