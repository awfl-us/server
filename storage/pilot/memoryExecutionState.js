import { assertAtomicRecordStore, checkKey, copy, RecordConflictError } from './contract.js';

const fail = (message) => { throw new RecordConflictError(message); };
const requireSize = (value, name) => {
  if (value === undefined || Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) {
    throw new TypeError(`${name} is required and must fit within 256 KiB`);
  }
};
const TERMINAL = new Set(['completed', 'cancelled', 'failed']);

// Intentionally small, storage-provider-neutral implementation of the *memory*
// root execution lifecycle, with the call shape consumed by memoryWorker.js.
// NOT a substitute for durable effect journals or nested parallel-fork ancestry.
export class NativeMemoryExecutionPilotStore {
  constructor({ records, clock = () => Date.now() }) {
    this.records = assertAtomicRecordStore(records);
    this.clock = clock;
  }
  async create({ executionId, userId, projectId, artifactSha256, input,
    protocolVersion = 2, workflowName, allowedOperations, parallelVersion,
    streamIpcVersion, trustedGlobalsVersion, executionMode = 'memory' }) {
    checkKey(executionId);
    requireSize(input, 'input');
    if (!userId || !projectId || !workflowName || !/^[a-f0-9]{64}$/.test(artifactSha256 || '') ||
        protocolVersion !== 2 || executionMode !== 'memory' ||
        !Array.isArray(allowedOperations)) throw new TypeError('invalid memory execution');
    const now = this.clock();
    const state = { executionId, userId, projectId, artifactSha256, input: copy(input),
      workflowName, allowedOperations: [...allowedOperations], protocolVersion,
      ...(parallelVersion && { parallelVersion }),
      ...(streamIpcVersion && { streamIpcVersion }),
      ...(trustedGlobalsVersion && { trustedGlobalsVersion }),
      executionMode, status: 'ready', owner: null, epoch: 0,
      leaseUntil: 0, effectCount: 0, pendingEffect: null,
      createdAt: now, updatedAt: now };
    await this.records.create(executionId, state);
    return copy(state);
  }
  async get(executionId) { return this.records.get(checkKey(executionId)); }
  async claim({ executionId, workerId, leaseMs = 60_000,
    expectedUserId, expectedProjectId, expectedExecutionMode = 'memory' }) {
    if (!workerId || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3_600_000) {
      throw new TypeError('invalid worker or lease');
    }
    let outcome;
    await this.records.mutate(executionId, state => {
      const now = this.clock();
      if (!state) return fail('execution not found');
      if ((expectedUserId && state.userId !== expectedUserId) ||
          (expectedProjectId && state.projectId !== expectedProjectId) ||
          state.executionMode !== expectedExecutionMode) return fail('execution scope mismatch');
      if (state.status === 'completed') { outcome = { completed: true, result: copy(state.result) }; return state; }
      if (state.status === 'cancelled') { outcome = { cancelled: true }; return state; }
      if (state.status === 'failed') { outcome = { failed: true, error: copy(state.error) }; return state; }
      if (state.owner && state.leaseUntil > now) {
        if (state.owner !== workerId) return fail('lease held');
        outcome = copy(state);
        return state;
      }
      const next = { ...state, owner: workerId, epoch: state.epoch + 1,
        leaseUntil: now + leaseMs, status: 'running', effectCount: 0,
        pendingEffect: null, progress: null, updatedAt: now };
      outcome = copy(next);
      return next;
    });
    return outcome;
  }
  async guarded({ executionId, workerId, epoch, update }) {
    return this.records.mutate(executionId, state => {
      const now = this.clock();
      if (!state || state.executionMode !== 'memory' || state.status !== 'running' ||
          state.owner !== workerId || state.epoch !== epoch || state.leaseUntil <= now ||
          state.pendingEffect) return fail('stale memory execution');
      return { ...update(state), updatedAt: now };
    });
  }
  async updateMemoryProgress({ executionId, workerId, epoch, progress }) {
    requireSize(progress, 'progress');
    if (!Number.isSafeInteger(progress?.effectCount) || progress.effectCount < 0) {
      throw new TypeError('invalid progress');
    }
    return this.guarded({ executionId, workerId, epoch, update: state => ({
      ...state, progress: copy(progress), effectCount: progress.effectCount,
    }) });
  }
  async complete({ executionId, workerId, epoch, result, effectCount }) {
    requireSize(result, 'result');
    if (effectCount !== undefined && (!Number.isSafeInteger(effectCount) || effectCount < 0)) {
      throw new TypeError('invalid effectCount');
    }
    return this.guarded({ executionId, workerId, epoch, update: state => ({
      ...state, status: 'completed', result: copy(result),
      ...(effectCount !== undefined && { effectCount }),
      owner: null, leaseUntil: 0, asyncLaunch: false,
    }) });
  }
  async fail({ executionId, workerId, epoch, error, effectCount }) {
    requireSize(error, 'error');
    return this.guarded({ executionId, workerId, epoch, update: state => ({
      ...state, status: 'failed', error: copy(error),
      ...(effectCount !== undefined && { effectCount }),
      owner: null, leaseUntil: 0, asyncLaunch: false,
    }) });
  }
  async cancel({ executionId, userId, projectId }) {
    return this.records.mutate(executionId, state => {
      if (!state || state.userId !== userId || state.projectId !== projectId ||
          TERMINAL.has(state.status)) return fail('cannot cancel execution');
      return { ...state, status: 'cancelled', owner: null, leaseUntil: 0,
        epoch: state.epoch + 1, updatedAt: this.clock() };
    });
  }
}
