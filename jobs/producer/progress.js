// Progress scheduler for project.status_message during producer/consumer startup
// - Emits a fixed sequence of 7 messages over ~80 seconds
// - Idempotent per (userId, projectId): at most one active schedule per key
// - Clears status_message at the end or on cancel/error

import { projectDoc } from '../../workflows/projects/util.js';

const DEFAULT_MESSAGES = [
  'Acquiring cloud compute..',
  'Fetching cloud images..',
  'Starting cloud instance..',
  'Starting cloud consumer..',
  'Syncing cloud storage..',
  'Consuming events queue..',
  'Cloud consumer started!',
];

const schedules = new Map(); // key -> { timers: NodeJS.Timeout[], startedAt: number, done: boolean }

function keyOf(userId, projectId) {
  return `${userId}:${projectId}`;
}

async function setStatusMessage({ userId, projectId, message }) {
  try {
    const ref = projectDoc(userId, projectId);
    await ref.set({ status_message: message ?? null, updated: Date.now() }, { merge: true });
  } catch (e) {
    // Best-effort: log to console but do not throw
    console.warn('[progress] failed to set status_message', { userId, projectId, err: e?.message || String(e) });
  }
}

// Public helper to update the startup status message from external watchers/pollers.
export async function setStartupStatus({ userId, projectId, message }) {
  await setStatusMessage({ userId, projectId, message });
}

export async function clearStatusMessage({ userId, projectId }) {
  await setStatusMessage({ userId, projectId, message: null });
}

export function cancelStartupProgress({ userId, projectId, reason = 'cancelled' }) {
  const key = keyOf(userId, projectId);
  const state = schedules.get(key);
  if (!state) return { ok: true, cancelled: false };
  for (const t of state.timers || []) {
    try { clearTimeout(t); } catch {}
  }
  schedules.delete(key);
  // Clear status message on cancel
  void clearStatusMessage({ userId, projectId });
  console.log('[progress] cancelled', { key, reason });
  return { ok: true, cancelled: true };
}

// Mark progress as completed early: clear timers, clear message immediately.
export function completeStartupProgress({ userId, projectId, reason = 'completed' }) {
  const key = keyOf(userId, projectId);
  const state = schedules.get(key);
  if (state) {
    for (const t of state.timers || []) {
      try { clearTimeout(t); } catch {}
    }
    schedules.delete(key);
  }
  void clearStatusMessage({ userId, projectId });
  console.log('[progress] completed-early', { key, reason });
  return { ok: true, completed: true };
}

export function scheduleStartupProgress({
  userId,
  projectId,
  messages = DEFAULT_MESSAGES,
  totalMs = 80_000,
  clearDelayMs = 1_000,
}) {
  if (!userId || !projectId) return { ok: false, error: 'userId and projectId required' };
  const key = keyOf(userId, projectId);

  // If a schedule already exists, replace it to keep behavior idempotent and deterministic
  if (schedules.has(key)) {
    cancelStartupProgress({ userId, projectId, reason: 'reschedule' });
  }

  const timers = [];
  const startedAt = Date.now();
  schedules.set(key, { timers, startedAt, done: false });

  const steps = Array.isArray(messages) && messages.length > 0 ? messages : DEFAULT_MESSAGES;
  const n = steps.length;
  const stepDelay = n > 1 ? Math.floor(totalMs / (n - 1)) : totalMs;

  // First message immediately
  void setStatusMessage({ userId, projectId, message: steps[0] });

  // Subsequent messages spaced evenly
  for (let i = 1; i < n; i++) {
    const delay = i * stepDelay;
    const t = setTimeout(() => {
      const state = schedules.get(key);
      if (!state || state.done) return; // cancelled or already done
      void setStatusMessage({ userId, projectId, message: steps[i] });

      // After final message, schedule clear
      if (i === n - 1) {
        const clearT = setTimeout(() => {
          const finalState = schedules.get(key);
          if (!finalState || finalState.done) return;
          finalState.done = true;
          void clearStatusMessage({ userId, projectId });
          schedules.delete(key);
          console.log('[progress] completed', { key, durationMs: Date.now() - startedAt });
        }, Math.max(0, clearDelayMs));
        try { timers.push(clearT); } catch {}
      }
    }, Math.max(0, delay));
    try { timers.push(t); } catch {}
  }

  console.log('[progress] scheduled', { key, totalMs, steps: n, stepDelay });
  return { ok: true, scheduled: true, key };
}

export default {
  scheduleStartupProgress,
  cancelStartupProgress,
  clearStatusMessage,
  completeStartupProgress,
  setStartupStatus,
};
