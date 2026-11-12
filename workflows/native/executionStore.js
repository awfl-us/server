// Firestore-backed durable native workflow control plane. No external effects
// execute inside transactions. Production routing is explicitly opt-in.
// All mutations are serialized on one execution document and fenced by epoch.
import { createHash } from 'node:crypto';

const id = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value)) {
    throw new Error('invalid execution or effect identifier');
  }
  return value;
};
const checkNodeId = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(value)) {
    throw new Error('invalid native node identifier');
  }
  return value;
};
const requireValue = (value, name) => {
  if (value === undefined) throw new Error(`${name} required`);
  return value;
};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = message => Object.assign(new Error(message), { code: 'CONFLICT' });
const LIMIT = { input: 256 * 1024, checkpoint: 256 * 1024,
  effectArgs: 128 * 1024, effectOutcome: 128 * 1024 };
const enforceBytes = (value, max, description) => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized) > max) {
    throw new Error(description + ' exceeds native persistence size limit');
  }
};

// Firestore rejects an array directly nested inside another array. Native
// inputs, arguments, outcomes and results can contain arbitrary JSON;
// persist them as bounded JSON strings and hydrate the store API on reads.
// Tagged continuation slots remain structured maps for atomic updates.
const storedJson = (record, field) =>
  Object.hasOwn(record, field + 'Json') ? JSON.parse(record[field + 'Json']) : record[field];
const hydrateState = state => state && ({
  ...state,
  input: storedJson(state, 'input'),
  forkLane: storedJson(state, 'forkLane'),
  result: storedJson(state, 'result'),
  error: storedJson(state, 'error'),
  pendingEffect: state.pendingEffect && {
    ...state.pendingEffect,
    args: storedJson(state.pendingEffect, 'args'),
  },
});
const hydrateJournal = journal => journal && ({
  ...journal, outcome: storedJson(journal, 'outcome'),
});

// A child must remain authorized by EVERY still-pending ancestor fork. Merely
// checking the immediate parent and the root's terminal status is insufficient:
// a root can finish one fork and move on while a nested grandchild still has
// a live parent. Traverse the bounded ancestry (max 3) inside the SAME
// Firestore transaction as each child create/claim/write, fencing any stale
// descendant without relying on asynchronous cleanup.
async function verifyForkAncestors(tx, collection, state) {
  if (!state.forkLaneJson) return;
  let current = state;
  const visited = new Set([state.executionId]);
  for (let index = 0; index < 3; index++) {
    const lane = JSON.parse(current.forkLaneJson);
    if (visited.has(lane.parentExecutionId)) throw conflict('native fork ancestor cycle');
    visited.add(lane.parentExecutionId);
    const parentSnap = await tx.get(collection.doc(lane.parentExecutionId));
    if (!parentSnap.exists) throw conflict('native fork parent missing');
    const parent = parentSnap.data();
    if (parent.status !== 'waiting_effect' ||
        parent.pendingEffect?.operation !== 'native.parallel' ||
        parent.pendingEffect?.effectId !== lane.generation ||
        parent.pendingEffect?.nodeId !== lane.nodeId ||
        parent.userId !== state.userId ||
        parent.projectId !== state.projectId ||
        parent.artifactSha256 !== state.artifactSha256 ||
        parent.workflowName !== state.workflowName ||
        parent.protocolVersion !== state.protocolVersion ||
        parent.parallelVersion !== 1) {
      throw conflict('native fork parent is no longer active');
    }
    if (!parent.forkLaneJson) {
      if (lane.parentExecutionId !== lane.rootExecutionId || lane.depth !== 1) {
        throw conflict('native fork root lineage mismatch');
      }
      return;
    }
    const parentLane = JSON.parse(parent.forkLaneJson);
    if (parentLane.rootExecutionId !== lane.rootExecutionId ||
        parentLane.depth + 1 !== lane.depth) {
      throw conflict('native fork ancestor lineage mismatch');
    }
    current = parent;
  }
  throw conflict('native fork ancestry exceeds maximum depth');
}

// The Rust continuation stores tagged values. Do not silently coerce 64-bit
// integers through JavaScript's imprecise Number representation.
export function tagNativeValue(value) {
  if (value === null) return { type: 'null' };
  if (typeof value === 'boolean') return { type: 'bool', value };
  if (typeof value === 'string') return { type: 'string', value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite native effect result');
    if (Number.isInteger(value)) {
      if (!Number.isSafeInteger(value)) throw new Error('unsafe integer native effect result');
      return { type: 'integer', value };
    }
    return { type: 'float', value };
  }
  if (Array.isArray(value)) return { type: 'list', value: value.map(tagNativeValue) };
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return { type: 'map', value: Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, tagNativeValue(nested)])) };
  }
  throw new Error('unsupported native effect result type');
}

export class NativeExecutionStore {
  constructor({ db, clock = () => Date.now(), collection = 'nativeWorkflowExecutions' }) {
    if (!db?.runTransaction || !db?.collection) throw new Error('Firestore required');
    this.db = db;
    this.clock = clock;
    this.collectionName = collection;
    this.collection = db.collection(collection);
  }
  ref(executionId) { return this.collection.doc(id(executionId)); }
  permitRef(rootExecutionId, slot) {
    if (!Number.isSafeInteger(slot) || slot < 0 || slot >= 8) {
      throw new Error('invalid native distributed permit slot');
    }
    // Resolve lazily: ordinary status/cancel access and non-parallel workers
    // never need to load the additional collection at all.
    return this.db.collection(this.collectionName + 'PermitSlots')
      .doc(id(rootExecutionId) + '_' + slot);
  }
  /** Try to admit one unit of actual work; null means this slot is busy.
   * The root owner/terminal check and slot reservation are one transaction.
   */
  async tryAcquirePermit({ rootExecutionId, userId, projectId, permitId,
                           slot, leaseMs = 120_000 }) {
    id(permitId);
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 600_000) {
      throw new Error('invalid native permit lease duration');
    }
    const rootRef = this.ref(rootExecutionId);
    const permitRef = this.permitRef(rootExecutionId, slot);
    return this.db.runTransaction(async tx => {
      const [rootSnap, permitSnap] = await Promise.all([tx.get(rootRef), tx.get(permitRef)]);
      const root = rootSnap.exists && rootSnap.data();
      if (!root || root.userId !== userId || root.projectId !== projectId ||
          root.parallelVersion !== 1 || root.forkLaneJson ||
          ['completed', 'failed', 'cancelled'].includes(root.status)) {
        throw conflict('native distributed permit root is no longer active or authorized');
      }
      const now = this.clock();
      const previous = permitSnap.exists ? permitSnap.data() : null;
      if (previous && previous.leaseUntil > now) return null;
      const next = { rootExecutionId, userId, projectId, slot, permitId,
        epoch: (previous?.epoch || 0) + 1, leaseUntil: now + leaseMs,
        updatedAt: now };
      if (permitSnap.exists) tx.update(permitRef, next);
      else tx.create(permitRef, next);
      return { slot, permitId, epoch: next.epoch, leaseUntil: next.leaseUntil };
    });
  }
  async renewPermit({ rootExecutionId, userId, projectId, permitId,
                      slot, epoch, leaseMs = 120_000 }) {
    id(permitId);
    if (!Number.isSafeInteger(epoch) || epoch < 1 ||
        !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 600_000) {
      throw new Error('invalid native distributed permit renewal');
    }
    const rootRef = this.ref(rootExecutionId);
    const permitRef = this.permitRef(rootExecutionId, slot);
    return this.db.runTransaction(async tx => {
      const [rootSnap, permitSnap] = await Promise.all([tx.get(rootRef), tx.get(permitRef)]);
      const root = rootSnap.exists && rootSnap.data();
      const current = permitSnap.exists && permitSnap.data();
      const now = this.clock();
      if (!root || root.userId !== userId || root.projectId !== projectId ||
          root.parallelVersion !== 1 || root.forkLaneJson ||
          ['completed', 'failed', 'cancelled'].includes(root.status) ||
          !current || current.permitId !== permitId || current.epoch !== epoch ||
          current.leaseUntil <= now || current.userId !== userId ||
          current.projectId !== projectId) {
        throw conflict('native distributed permit lease is stale or root is terminal');
      }
      const next = { ...current, leaseUntil: now + leaseMs, updatedAt: now };
      tx.update(permitRef, next);
      return next.leaseUntil;
    });
  }
  /** A stale worker cannot release a slot another process has reclaimed. */
  async releasePermit({ rootExecutionId, permitId, slot, epoch }) {
    id(permitId);
    if (!Number.isSafeInteger(epoch) || epoch < 1) {
      throw new Error('invalid native distributed permit epoch');
    }
    const ref = this.permitRef(rootExecutionId, slot);
    return this.db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.data().permitId !== permitId ||
          snap.data().epoch !== epoch) return false;
      tx.update(ref, { ...snap.data(), permitId: null, leaseUntil: 0,
        updatedAt: this.clock() });
      return true;
    });
  }
  effectRef(executionId, effectId) {
    return this.db.collection(this.collectionName + '/' + id(executionId) + '/effects')
      .doc(id(effectId));
  }
  async getEffect(executionId, effectId) {
    const snap = await this.effectRef(executionId, effectId).get();
    return snap.exists ? hydrateJournal(snap.data()) : null;
  }

  async create({ executionId, userId, projectId, artifactSha256, input,
                 protocolVersion = 1, workflowName, allowedOperations,
                 trustedGlobalsVersion, parallelVersion, forkLane }) {
    id(executionId);
    if (!userId || !projectId || !/^[a-f0-9]{64}$/.test(artifactSha256 || '')) {
      throw new Error('owner and pinned artifact SHA-256 required');
    }
    if (protocolVersion !== 1 && protocolVersion !== 2) {
      throw new Error('unsupported native artifact protocol version');
    }
    if (workflowName !== undefined &&
        (typeof workflowName !== 'string' ||
         !/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(workflowName))) {
      throw new Error('invalid pinned native workflow name');
    }
    const allowed = new Set(['http.get', 'http.post', 'http.patch', 'http.delete', 'log.write', 'native.parallel']);
    if (allowedOperations !== undefined &&
        (!Array.isArray(allowedOperations) ||
         allowedOperations.some(op => !allowed.has(op)) ||
         new Set(allowedOperations).size !== allowedOperations.length)) {
      throw new Error('invalid pinned native operations');
    }
    if (trustedGlobalsVersion !== undefined &&
        (trustedGlobalsVersion !== 1 || protocolVersion !== 2)) {
      throw new Error('invalid pinned native trusted globals version');
    }
    if (parallelVersion !== undefined && (parallelVersion !== 1 || protocolVersion !== 2)) {
      throw new Error('invalid pinned native parallel version');
    }
    if (allowedOperations?.includes('native.parallel') && parallelVersion !== 1) {
      throw new Error('parallel operation requires a pinned parallel-capable release');
    }
    if (parallelVersion === 1 && !allowedOperations?.includes('native.parallel')) {
      throw new Error('parallel-capable release must authorize native.parallel');
    }
    if (forkLane !== undefined) {
      if (parallelVersion !== 1 || !forkLane ||
          !/^native_[a-f0-9]{32}$/.test(forkLane.parentExecutionId || '') ||
          !/^native_[a-f0-9]{32}$/.test(forkLane.rootExecutionId || '') ||
          !Number.isSafeInteger(forkLane.depth) || forkLane.depth < 1 || forkLane.depth > 3 ||
          !/^[A-Za-z0-9_.-]{1,120}$/.test(forkLane.nodeId || '') ||
          !/^[A-Za-z0-9_.:-]{1,160}$/.test(forkLane.generation || '') ||
          !Number.isSafeInteger(forkLane.index) || forkLane.index < 0 || forkLane.index >= 10000 ||
          !/^pc_(0|[1-9][0-9]{0,8})$/.test(forkLane.entry || '') ||
          !/^[a-f0-9]{64}$/.test(forkLane.snapshotSha256 || '') ||
          !forkLane.slots || typeof forkLane.slots !== 'object' ||
          Array.isArray(forkLane.slots)) {
        throw new Error('invalid native fork lane metadata');
      }
      if (forkLane.snapshotSha256 !== digest({
        input, slots: forkLane.slots, entry: forkLane.entry,
      }) || executionId !== 'native_' + digest([
        forkLane.parentExecutionId, forkLane.nodeId, forkLane.generation, forkLane.index,
      ]).slice(0, 32)) {
        throw new Error('native fork lane digest or deterministic identity mismatch');
      }
      enforceBytes(forkLane, LIMIT.checkpoint, 'native fork lane snapshot');
    }
    requireValue(input, 'input');
    enforceBytes(input, LIMIT.input, 'workflow input');
    const ref = this.ref(executionId);
    return this.db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (snap.exists) throw conflict('execution already exists');
      const now = this.clock();
      const state = { schemaVersion: 1, executionId, userId, projectId, artifactSha256, protocolVersion,
        ...(workflowName && { workflowName }),
        ...(allowedOperations && { allowedOperations: [...allowedOperations] }),
        ...(trustedGlobalsVersion === 1 && { trustedGlobalsVersion: 1 }),
        ...(parallelVersion === 1 && { parallelVersion: 1 }),
        ...(forkLane && { forkLane: null, forkLaneJson: JSON.stringify(forkLane) }),
        input: null, inputJson: JSON.stringify(input),
        status: 'ready', epoch: 0, owner: null, leaseUntil: 0,
        checkpoint: forkLane ? {
          next_step: Number(forkLane.entry.slice(3)),
          slots: forkLane.slots, frames: [],
        } : null,
        pendingEffect: null, effectCount: 0, result: null,
        createdAt: now, updatedAt: now };
      await verifyForkAncestors(tx, this.collection, state);
      tx.create(ref, state);
      return hydrateState(state);
    });
  }

  async get(executionId) {
    const snap = await this.ref(executionId).get();
    return snap.exists ? hydrateState(snap.data()) : null;
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
      if (s.status === 'completed') return {
        completed: true, result: storedJson(s, 'result'),
      };
      if (s.status === 'cancelled') return { cancelled: true };
      if (s.status === 'failed') return { failed: true, error: storedJson(s, 'error') };
      await verifyForkAncestors(tx, this.collection, s);
      if (s.owner && s.leaseUntil > now) {
        // Allow the same still-fenced worker to resume after a recorded effect.
        if (s.owner === workerId) return hydrateState(s);
        throw conflict('lease held');
      }
      const next = { ...s, owner: workerId, epoch: s.epoch + 1,
        leaseUntil: now + leaseMs, updatedAt: now };
      tx.update(ref, next);
      return hydrateState(next);
    });
  }

  async mutate(executionId, workerId, epoch, change, journalEffectId) {
    const ref = this.ref(executionId);
    const effectRef = journalEffectId ? this.effectRef(executionId, journalEffectId) : null;
    return this.db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const recorded = effectRef ? await tx.get(effectRef) : null;
      if (!snap.exists) throw conflict('execution not found');
      const s = snap.data(), now = this.clock();
      if (s.owner !== workerId || s.epoch !== epoch || s.leaseUntil <= now) {
        throw conflict('stale worker fencing token');
      }
      if (s.status === 'completed' || s.status === 'cancelled' || s.status === 'failed') throw conflict('execution is terminal');
      await verifyForkAncestors(tx, this.collection, s);
      const next = change(s, now, recorded, tx, effectRef);
      tx.update(ref, { ...next, updatedAt: now });
      return hydrateState(next);
    });
  }

  async renew({ executionId, workerId, epoch, leaseMs = 60_000 }) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3600000) {
      throw new Error('invalid lease duration');
    }
    return this.mutate(executionId, workerId, epoch, (s, now) => ({
      ...s, leaseUntil: now + leaseMs,
    }));
  }

  // A cancelled execution is terminal. The caller must authenticate the owner;
  // cancellation does not undo an external effect already in flight.
  async cancel({ executionId, userId, projectId }) {
    const ref = this.ref(executionId);
    return this.db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw conflict('execution not found');
      const s = snap.data();
      if (s.userId !== userId || s.projectId !== projectId) throw conflict('owner mismatch');
      if (s.status === 'completed') throw conflict('execution already completed');
      if (s.status === 'failed') throw conflict('execution already failed');
      if (s.status === 'cancelled') return hydrateState(s);
      const next = { ...s, status: 'cancelled', owner: null,
        epoch: s.epoch + 1, leaseUntil: 0, updatedAt: this.clock() };
      tx.update(ref, next);
      return hydrateState(next);
    });
  }

  async checkpoint({ executionId, workerId, epoch, nodeId, slots }) {
    checkNodeId(nodeId);
    requireValue(slots, 'slots');
    enforceBytes(slots, LIMIT.checkpoint, 'native checkpoint');
    return this.mutate(executionId, workerId, epoch, (s, now) => {
      if (s.pendingEffect) throw conflict('effect pending; cannot advance checkpoint');
      return { ...s, checkpoint: { nodeId, slots, savedAt: now } };
    });
  }

  async prepareEffect({ executionId, workerId, epoch, nodeId, effectId, operation,
                        args, slots, continuation, resultSlot, protocolVersion = 1,
                        onError }) {
    checkNodeId(nodeId); id(effectId);
    if (protocolVersion !== 1 && protocolVersion !== 2) {
      throw new Error('unsupported native continuation protocol');
    }
    if (onError !== undefined &&
        (protocolVersion !== 2 || !onError ||
         !Number.isSafeInteger(onError.nextStep) || onError.nextStep < 0 ||
         !/^s[0-9]+$/.test(onError.errorSlot || '') ||
         Object.keys(onError).some(key => !['nextStep', 'errorSlot'].includes(key)))) {
      throw new Error('invalid compiled native effect error edge');
    }
    if (!operation) throw new Error('operation required');
    requireValue(args, 'args'); requireValue(slots, 'slots');
    enforceBytes(args, LIMIT.effectArgs, 'native effect arguments');
    enforceBytes(slots, LIMIT.checkpoint, 'native checkpoint');
    if (continuation) {
      const validFrames = Array.isArray(continuation.frames) && continuation.frames.length <= 64 &&
        continuation.frames.every(f => f && typeof f === 'object' &&
          typeof f.node_id === 'string' && /^[A-Za-z0-9_.-]{1,120}$/.test(f.node_id) &&
          Number.isSafeInteger(f.iteration) && f.iteration >= 0);
      // A frame targets its containing top-level step, which may be step 0.
      // Frame-free continuations still advance beyond a completed effect.
      if (!Number.isSafeInteger(continuation.next_step) || continuation.next_step < 0 ||
          !validFrames ||
          (protocolVersion === 1 && continuation.frames.length === 0 && continuation.next_step === 0) ||
          (protocolVersion === 2 && continuation.frames.length !== 0) ||
          JSON.stringify(continuation.slots) !== JSON.stringify(slots)) {
        throw new Error('invalid native continuation');
      }
      if (!/^s[0-9]+$/.test(resultSlot || '')) throw new Error('native effect result slot required');
    }
    const fingerprint = digest({ nodeId, operation, args, resultSlot,
      ...(onError && { onError }) });
    return this.mutate(executionId, workerId, epoch, (s, now, journal) => {
      if ((s.protocolVersion || 1) !== protocolVersion) {
        throw conflict('artifact protocol differs from pinned execution');
      }
      const recorded = journal?.exists ? journal.data() : null;
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
        checkpoint: { nodeId, slots, savedAt: now,
          ...(continuation && { next_step: continuation.next_step, frames: continuation.frames }) },
        pendingEffect: { effectId, nodeId, operation,
          args: null, argsJson: JSON.stringify(args), fingerprint, preparedAt: now,
          ...(resultSlot && { resultSlot }), ...(onError && { onError }) } };
    }, effectId);
  }

  // Only an effect dispatcher may record the outcome; this method NEVER invokes
  // an HTTP API. The dispatcher must use effectId as the idempotency key where
  // supported, and reconcile uncertain outcomes after crashes.
  async recordEffect({ executionId, workerId, epoch, effectId, outcome }) {
    id(effectId); requireValue(outcome, 'outcome');
    enforceBytes(outcome, LIMIT.effectOutcome, 'native effect outcome');
    return this.mutate(executionId, workerId, epoch, (s, now, journal, tx, journalRef) => {
      const prior = journal?.exists ? journal.data() : null;
      if (prior) {
        if (prior.isError === true || digest(storedJson(prior, 'outcome')) !== digest(outcome)) {
          throw conflict('effect outcome differs');
        }
        return s;
      }
      if (!s.pendingEffect || s.pendingEffect.effectId !== effectId) {
        throw conflict('effect was not prepared');
      }
      const { fingerprint, resultSlot } = s.pendingEffect;
      // Record the outcome and resumable slot in the SAME fenced transaction.
      // A crash after this commit cannot require redispatching the HTTP call.
      const checkpoint = resultSlot ? {
        ...s.checkpoint,
        slots: { ...s.checkpoint.slots, [resultSlot]: tagNativeValue(outcome) },
      } : s.checkpoint;
      if (checkpoint) enforceBytes(checkpoint.slots, LIMIT.checkpoint, 'native checkpoint');
      // The outcome journal and resume checkpoint commit atomically.
      tx.create(journalRef, { effectId, fingerprint,
        outcome: null, outcomeJson: JSON.stringify(outcome), recordedAt: now });
      return { ...s, status: 'ready', pendingEffect: null,
        checkpoint, effectCount: (s.effectCount || 0) + 1 };
    }, effectId);
  }

  // Confirmed remote HTTP 4xx/5xx responses may be handled by an existing
  // compiled Try edge. Persist the failure journal, exception value, and
  // handler PC atomically under the same epoch fencing as successful effects.
  // This must never handle an unknown/timeout/transport outcome.
  async recordEffectFailure({ executionId, workerId, epoch, effectId, failure }) {
    id(effectId);
    if (!failure || typeof failure !== 'object' || Array.isArray(failure) ||
        typeof failure.message !== 'string' || failure.message.length > 256 ||
        !(failure.code === null ||
          (Number.isSafeInteger(failure.code) && failure.code >= 400 &&
           failure.code <= 599)) ||
        Object.keys(failure).some(key => !['message', 'code'].includes(key))) {
      throw new Error('confirmed native effect failure required');
    }
    enforceBytes(failure, LIMIT.effectOutcome, 'native effect failure');
    return this.mutate(executionId, workerId, epoch, (s, now, journal, tx, journalRef) => {
      const prior = journal?.exists ? journal.data() : null;
      if (prior) {
        if (prior.isError !== true || digest(storedJson(prior, 'outcome')) !== digest(failure)) {
          throw conflict('effect failure differs');
        }
        return s;
      }
      if (!s.pendingEffect || s.pendingEffect.effectId !== effectId || !s.pendingEffect.onError) {
        throw conflict('effect was not prepared with a compiled error handler');
      }
      if (failure.code === null && s.pendingEffect.operation !== 'native.parallel') {
        throw conflict('non-HTTP failures require an authenticated native fork');
      }
      const { fingerprint, onError } = s.pendingEffect;
      if (!s.checkpoint || !Number.isSafeInteger(s.checkpoint.next_step)) {
        throw conflict('missing native compiled continuation');
      }
      const checkpoint = {
        ...s.checkpoint, next_step: onError.nextStep,
        slots: { ...s.checkpoint.slots, [onError.errorSlot]: tagNativeValue(failure) },
      };
      enforceBytes(checkpoint.slots, LIMIT.checkpoint, 'native failed checkpoint');
      tx.create(journalRef, { effectId, fingerprint, isError: true,
        outcome: null, outcomeJson: JSON.stringify(failure), recordedAt: now });
      return { ...s, status: 'ready', pendingEffect: null, checkpoint,
        effectCount: (s.effectCount || 0) + 1 };
    }, effectId);
  }

  /** A child with a durably recorded terminal failure may fail an uncaught
    * parent fork atomically, while journaling the parent fork intent. This
    * never handles uncertain child transport/effect outcomes.
    */
  async failPendingParallel({ executionId, workerId, epoch, effectId, error }) {
    id(effectId);
    requireValue(error, 'error');
    enforceBytes(error, LIMIT.effectOutcome, 'native confirmed fork failure');
    return this.mutate(executionId, workerId, epoch, (s, now, journal, tx, ref) => {
      if (!s.pendingEffect || s.pendingEffect.operation !== 'native.parallel' ||
          s.pendingEffect.effectId !== effectId || journal?.exists) {
        throw conflict('confirmed parallel failure must match a pending fork');
      }
      tx.create(ref, {
        effectId, fingerprint: s.pendingEffect.fingerprint, isError: true,
        outcome: null, outcomeJson: JSON.stringify(error), recordedAt: now,
      });
      return { ...s, status: 'failed', pendingEffect: null,
        error: null, errorJson: JSON.stringify(error),
        owner: null, leaseUntil: 0, effectCount: (s.effectCount || 0) + 1 };
    }, effectId);
  }

  async fail({ executionId, workerId, epoch, error }) {
    requireValue(error, 'error');
    enforceBytes(error, LIMIT.checkpoint, 'native workflow failure');
    return this.mutate(executionId, workerId, epoch, s => {
      if (s.pendingEffect) throw conflict('effect outcome unresolved');
      return { ...s, status: 'failed', error: null, errorJson: JSON.stringify(error),
        owner: null, leaseUntil: 0 };
    });
  }

  async complete({ executionId, workerId, epoch, result }) {
    requireValue(result, 'result');
    enforceBytes(result, LIMIT.checkpoint, 'workflow result');
    return this.mutate(executionId, workerId, epoch, s => {
      if (s.pendingEffect) throw conflict('effect outcome unresolved');
      return { ...s, status: 'completed',
        result: null, resultJson: JSON.stringify(result), owner: null, leaseUntil: 0 };
    });
  }
}
