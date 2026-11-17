import { sanitizeEnvironment } from '../../mcp/environment.js';
import { getDocumentStorage } from '../../storage/service.js';
import { projectPath } from './util.js';

function nowMs() { return Date.now(); }
function clampLeaseMs(input) {
  const n = Number(input);
  const d = 10 * 60 * 1000; // 10m default
  if (!Number.isFinite(n)) return d;
  return Math.max(5_000, Math.min(60 * 60 * 1000, Math.floor(n))); // 5s..60m
}

function shapeLock(lock) {
  if (!lock) return null;
  const { consumerId, consumerType, leaseMs, acquiredAt, refreshedAt, expiresAt } = lock;
  return { consumerId, consumerType, leaseMs, acquiredAt, refreshedAt: refreshedAt || acquiredAt, expiresAt,
    ...(lock.runtime?.imageProfile ? { imageProfile: lock.runtime.imageProfile } : {}) };
}

export async function acquireConsumerLock({ userId, projectId, consumerId, leaseMs, consumerType = 'CLOUD' }) {
  if (!userId) throw new Error('acquireConsumerLock: userId required');
  if (!projectId) throw new Error('acquireConsumerLock: projectId required');
  if (!consumerId) throw new Error('acquireConsumerLock: consumerId required');

  const pid = String(projectId).trim();
  const path = projectPath(userId, pid);
  const lease = clampLeaseMs(leaseMs);

  const db = await getDocumentStorage();
  const result = await db.transaction(async (tx) => {
    const snap = await tx.get(path);
    if (!snap) {
      const err = new Error('Project not found');
      err.code = 404;
      throw err;
    }

    const data = snap.data || {};
    const existing = data.consumerLock || null;
    const now = nowMs();

    if (!existing || (existing.expiresAt ?? 0) <= now) {
      const newLock = {
        consumerId,
        consumerType: String(consumerType || 'CLOUD').toUpperCase(),
        leaseMs: lease,
        acquiredAt: now,
        refreshedAt: now,
        expiresAt: now + lease,
        runtime: null,
      };
      await tx.put(path, { consumerLock: newLock, updated: now }, { merge: true });
      return { ok: true, lock: shapeLock(newLock) };
    }

    // If same holder, just refresh
    if (existing.consumerId === consumerId) {
      const refreshed = {
        ...existing,
        consumerType: String(consumerType || existing.consumerType || 'CLOUD').toUpperCase(),
        leaseMs: lease,
        refreshedAt: now,
        expiresAt: now + lease,
      };
      await tx.put(path, { consumerLock: refreshed, updated: now }, { merge: true });
      return { ok: true, lock: shapeLock(refreshed), refreshed: true };
    }

    // Held by someone else
    const msRemaining = Math.max(0, Number(existing.expiresAt || 0) - now);
    return { ok: false, conflict: true, holder: shapeLock(existing), msRemaining };
  });

  return result;
}

export async function releaseConsumerLock({ userId, projectId, consumerId, force = false }) {
  if (!userId) throw new Error('releaseConsumerLock: userId required');
  if (!projectId) throw new Error('releaseConsumerLock: projectId required');

  const pid = String(projectId).trim();
  const path = projectPath(userId, pid);

  const db = await getDocumentStorage();
  const result = await db.transaction(async (tx) => {
    const snap = await tx.get(path);
    if (!snap) {
      const err = new Error('Project not found');
      err.code = 404;
      throw err;
    }

    const data = snap.data || {};
    const existing = data.consumerLock || null;
    const now = nowMs();

    if (!existing) {
      return { ok: true, released: false };
    }

    if (force || (consumerId && existing.consumerId === consumerId)) {
      await tx.put(path, { consumerLock: null, updated: now }, { merge: true });
      return { ok: true, released: true };
    }

    const msRemaining = Math.max(0, Number(existing.expiresAt || 0) - now);
    return { ok: false, conflict: true, holder: shapeLock(existing), msRemaining };
  });

  return result;
}

export async function getConsumerLockStatus({ userId, projectId }) {
  if (!userId) throw new Error('getConsumerLockStatus: userId required');
  if (!projectId) throw new Error('getConsumerLockStatus: projectId required');

  const pid = String(projectId).trim();
  const path = projectPath(userId, pid);
  const snap = await (await getDocumentStorage()).get(path);
  if (!snap) {
    const err = new Error('Project not found');
    err.code = 404;
    throw err;
  }

  const data = snap.data || {};
  const existing = data.consumerLock || null;
  const now = nowMs();

  // Include status_message if present (omit when null/undefined for back-compat)
  const status = {};
  if (data.status_message != null) status.status_message = data.status_message;

  if (!existing) return { ok: true, locked: false, ...status };

  const msRemaining = Math.max(0, Number(existing.expiresAt || 0) - now);
  const locked = msRemaining > 0;
  return { ok: true, locked, holder: shapeLock(existing), msRemaining, ...status };
}

// New helpers to persist and fetch runtime information bound to the consumer lock
export async function setConsumerRuntimeInfo({ userId, projectId, consumerId, runtime }) {
  if (!userId) throw new Error('setConsumerRuntimeInfo: userId required');
  if (!projectId) throw new Error('setConsumerRuntimeInfo: projectId required');
  if (!consumerId) throw new Error('setConsumerRuntimeInfo: consumerId required');

  const pid = String(projectId).trim();
  const path = projectPath(userId, pid);

  const db = await getDocumentStorage();
  const result = await db.transaction(async (tx) => {
    const snap = await tx.get(path);
    if (!snap) {
      const err = new Error('Project not found');
      err.code = 404;
      throw err;
    }
    const data = snap.data || {};
    const existing = data.consumerLock || null;
    const now = nowMs();

    if (!existing || existing.consumerId !== consumerId) {
      return { ok: false, error: 'Lock not held by this consumer' };
    }

    const updated = { ...existing, runtime, refreshedAt: now };
    await tx.put(path, { consumerLock: updated, updated: now }, { merge: true });
    return { ok: true, lock: shapeLock(updated), runtime: runtime || null };
  });

  return result;
}

export async function getConsumerLock({ userId, projectId }) {
  if (!userId) throw new Error('getConsumerLock: userId required');
  if (!projectId) throw new Error('getConsumerLock: projectId required');
  const pid = String(projectId).trim();
  const path = projectPath(userId, pid);
  const snap = await (await getDocumentStorage()).get(path);
  if (!snap) {
    const err = new Error('Project not found');
    err.code = 404;
    throw err;
  }
  const data = snap.data || {};
  const lock = data.consumerLock || null;
  return { ok: true, lock: lock ? { ...shapeLock(lock), runtime: lock.runtime || null,
    heartbeat: lock.heartbeat || null } : null };
}


/**
 * Record application readiness on the EXISTING project consumer lock.
 * The caller must be Firebase-authorized for this project. A stale consumer
 * cannot update a replacement's heartbeat after its lease expires.
 */
export async function heartbeatConsumer({ userId, projectId, consumerId, connected, capacity, activeExecutions, capabilities, environment }) {
  const path = projectPath(userId, projectId);
  return (await getDocumentStorage()).transaction(async tx => {
    const snap = await tx.get(path);
    const lock = snap.data?.consumerLock;
    const now = Date.now();
    if (!snap || !lock || lock.consumerId !== consumerId || lock.expiresAt <= now) {
      return { ok: false, error: 'Consumer lock no longer held' };
    }
    const heartbeat = {
      consumerId,
      generation: lock.acquiredAt,
      at: now,
      connected: connected === true,
      phase: connected === true ? 'ready' : 'connecting_to_server',
      capacity: Math.min(Math.max(Number(capacity) || 0, 0), 64),
      activeExecutions: Array.isArray(activeExecutions)
        ? activeExecutions.filter(x => typeof x === 'string').slice(0, 64) : [],
      capabilities: Array.isArray(capabilities)
        ? capabilities.filter(x => typeof x === 'string').slice(0, 32) : [],
      environment: sanitizeEnvironment(environment),
    };
    await tx.put(path, { consumerLock: { ...lock, heartbeat } }, { merge: true });
    return { ok: true, heartbeat: { at: now, phase: heartbeat.phase } };
  });
}
