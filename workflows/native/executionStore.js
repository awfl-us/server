// Firestore-backed durable native workflow control plane. No external effects
// execute inside transactions. Deliberately not wired into production routing.
// All mutations are serialized on one execution document and fenced by epoch.
import { createHash } from 'node:crypto';

const id = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value)) {
    throw new Error('invalid execution or effect identifier');
  }
  return value;
};
const requireValue = (value, name) => {
  if (value === undefined) throw new Error(`${name} required`);
  return value;
};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = message => Object.assign(new Error(message), { code: 'CONFLICT' });

export class NativeExecutionStore {
  constructor({ db, clock = () => Date.now(), collection = 'nativeWorkflowExecutions' }) {
    if (!db?.runTransaction || !db?.collection) throw new Error('Firestore required');
    this.db = db;
    this.clock = clock;
    this.collection = db.collection(collection);
  }
  ref(executionId) { return this.collection.doc(id(executionId)); }

  async create({ executionId, userId, projectId, artifactSha256, input }) {
    id(executionId);
    if (!userId || !projectId || !/^[a-f0-9]{64}$/.test(artifactSha256 || '')) {
      throw new Error('owner and pinned artifact SHA-256 required');
    }
    requireValue(input, 'input');
    const ref = this.ref(executionId);
    return this.db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (snap.exists) throw conflict('execution already exists');
      const now = this.clock();
      const state = { schemaVersion: 1, executionId, userId, projectId, artifactSha256,
        input, status: 'ready', epoch: 0, owner: null, leaseUntil: 0,
        checkpoint: null, pendingEffect: null, effectResults: {}, result: null,
        createdAt: now, updatedAt: now };
      tx.create(ref, state);
      return state;
    });
  }

  async get(executionId) {
    const snap = await this.ref(executionId).get();
    return snap.exists ? snap.data() : null;
  }

  async claim({ executionId, workerId, leaseMs = 60_000 }) {
    id(workerId);
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3600000) {
      throw new Error('invalid lease duration');
    }
    const ref = this.ref(executionId);
    return this.db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw conflict('execution not found');
      const s = snap.data(), now = this.clock();
      if (s.status === 'completed') return { completed: true, result: s.result };
      if (s.owner && s.leaseUntil > now) throw conflict('lease held');
      const next = { ...s, owner: workerId, epoch: s.epoch + 1,
        leaseUntil: now + leaseMs, updatedAt: now };
      tx.update(ref, next);
      return next;
    });
  }

  async mutate(executionId, workerId, epoch, change) {
    const ref = this.ref(executionId);
    return this.db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw conflict('execution not found');
      const s = snap.data(), now = this.clock();
      if (s.owner !== workerId || s.epoch !== epoch || s.leaseUntil <= now) {
        throw conflict('stale worker fencing token');
      }
      if (s.status === 'completed') throw conflict('execution already completed');
      const next = change(s, now);
      tx.update(ref, { ...next, updatedAt: now });
      return next;
    });
  }

  async checkpoint({ executionId, workerId, epoch, nodeId, slots }) {
    id(nodeId);
    requireValue(slots, 'slots');
    return this.mutate(executionId, workerId, epoch, (s, now) => {
      if (s.pendingEffect) throw conflict('effect pending; cannot advance checkpoint');
      return { ...s, checkpoint: { nodeId, slots, savedAt: now } };
    });
  }

  async prepareEffect({ executionId, workerId, epoch, nodeId, effectId, operation, args, slots }) {
    id(nodeId); id(effectId);
    if (!operation) throw new Error('operation required');
    requireValue(args, 'args'); requireValue(slots, 'slots');
    const fingerprint = digest({ nodeId, operation, args });
    return this.mutate(executionId, workerId, epoch, (s, now) => {
      const recorded = s.effectResults[effectId];
      if (recorded) {
        if (recorded.fingerprint !== fingerprint) throw conflict('effect ID reused with different arguments');
        return s;
      }
      if (s.pendingEffect) {
        if (s.pendingEffect.effectId !== effectId || s.pendingEffect.fingerprint !== fingerprint) {
          throw conflict('different effect already pending');
        }
        return s;
      }
      return { ...s, status: 'waiting_effect',
        checkpoint: { nodeId, slots, savedAt: now },
        pendingEffect: { effectId, nodeId, operation, args, fingerprint, preparedAt: now } };
    });
  }

  // Only an effect dispatcher may record the outcome; this method NEVER invokes
  // an HTTP API. The dispatcher must use effectId as the idempotency key where
  // supported, and reconcile uncertain outcomes after crashes.
  async recordEffect({ executionId, workerId, epoch, effectId, outcome }) {
    id(effectId); requireValue(outcome, 'outcome');
    return this.mutate(executionId, workerId, epoch, s => {
      const prior = s.effectResults[effectId];
      if (prior) {
        if (digest(prior.outcome) !== digest(outcome)) throw conflict('effect outcome differs');
        return s;
      }
      if (!s.pendingEffect || s.pendingEffect.effectId !== effectId) {
        throw conflict('effect was not prepared');
      }
      const { fingerprint } = s.pendingEffect;
      return { ...s, status: 'ready', pendingEffect: null,
        effectResults: { ...s.effectResults, [effectId]: { fingerprint, outcome } } };
    });
  }

  async complete({ executionId, workerId, epoch, result }) {
    requireValue(result, 'result');
    return this.mutate(executionId, workerId, epoch, s => {
      if (s.pendingEffect) throw conflict('effect outcome unresolved');
      return { ...s, status: 'completed', result, owner: null, leaseUntil: 0 };
    });
  }
}
