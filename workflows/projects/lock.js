import { getFirestore } from 'firebase-admin/firestore';
import { projectDoc } from './util.js';

const db = getFirestore();

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
  return { consumerId, consumerType, leaseMs, acquiredAt, refreshedAt: refreshedAt || acquiredAt, expiresAt };
}

export async function acquireConsumerLock({ userId, projectId, consumerId, leaseMs, consumerType = 'CLOUD' }) {
  if (!userId) throw new Error('acquireConsumerLock: userId required');
  if (!projectId) throw new Error('acquireConsumerLock: projectId required');
  if (!consumerId) throw new Error('acquireConsumerLock: consumerId required');

  const pid = String(projectId).trim();
  const ref = projectDoc(userId, pid);
  const lease = clampLeaseMs(leaseMs);

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      const err = new Error('Project not found');
      err.code = 404;
      throw err;
    }

    const data = snap.data() || {};
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
      tx.set(ref, { consumerLock: newLock, updated: now }, { merge: true });
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
      tx.set(ref, { consumerLock: refreshed, updated: now }, { merge: true });
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
  const ref = projectDoc(userId, pid);

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      const err = new Error('Project not found');
      err.code = 404;
      throw err;
    }

    const data = snap.data() || {};
    const existing = data.consumerLock || null;
    const now = nowMs();

    if (!existing) {
      return { ok: true, released: false };
    }

    if (force || (consumerId && existing.consumerId === consumerId)) {
      tx.set(ref, { consumerLock: null, updated: now }, { merge: true });
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
  const ref = projectDoc(userId, pid);
  const snap = await ref.get();
  if (!snap.exists) {
    const err = new Error('Project not found');
    err.code = 404;
    throw err;
  }

  const data = snap.data() || {};
  const existing = data.consumerLock || null;
  const now = nowMs();

  if (!existing) return { ok: true, locked: false };

  const msRemaining = Math.max(0, Number(existing.expiresAt || 0) - now);
  const locked = msRemaining > 0;
  return { ok: true, locked, holder: shapeLock(existing), msRemaining };
}

// New helpers to persist and fetch runtime information bound to the consumer lock
export async function setConsumerRuntimeInfo({ userId, projectId, consumerId, runtime }) {
  if (!userId) throw new Error('setConsumerRuntimeInfo: userId required');
  if (!projectId) throw new Error('setConsumerRuntimeInfo: projectId required');
  if (!consumerId) throw new Error('setConsumerRuntimeInfo: consumerId required');

  const pid = String(projectId).trim();
  const ref = projectDoc(userId, pid);

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      const err = new Error('Project not found');
      err.code = 404;
      throw err;
    }
    const data = snap.data() || {};
    const existing = data.consumerLock || null;
    const now = nowMs();

    if (!existing || existing.consumerId !== consumerId) {
      return { ok: false, error: 'Lock not held by this consumer' };
    }

    const updated = { ...existing, runtime, refreshedAt: now };
    tx.set(ref, { consumerLock: updated, updated: now }, { merge: true });
    return { ok: true, lock: shapeLock(updated), runtime: runtime || null };
  });

  return result;
}

export async function getConsumerLock({ userId, projectId }) {
  if (!userId) throw new Error('getConsumerLock: userId required');
  if (!projectId) throw new Error('getConsumerLock: projectId required');
  const pid = String(projectId).trim();
  const ref = projectDoc(userId, pid);
  const snap = await ref.get();
  if (!snap.exists) {
    const err = new Error('Project not found');
    err.code = 404;
    throw err;
  }
  const data = snap.data() || {};
  const lock = data.consumerLock || null;
  return { ok: true, lock: lock ? { ...shapeLock(lock), runtime: lock.runtime || null } : null };
}
