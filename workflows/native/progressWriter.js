// Best-effort observational snapshots for the memory-first native executor.
// At most one write is in flight and only the newest queued snapshot survives.
// No timer or write lives beyond the awaited Jobs HTTP request.
export function createNativeProgressWriter(write, { intervalMs = 1500 } = {}) {
  if (typeof write !== 'function' || !Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new Error('progress writer needs a callback and positive interval');
  }
  let latest = null, active = null, timer = null, closed = false;
  let lastWriteAt = Date.now();
  let failures = 0;

  const schedule = () => {
    if (closed || timer || active || latest === null) return;
    const delay = Math.max(0, lastWriteAt + intervalMs - Date.now());
    timer = setTimeout(() => {
      timer = null;
      if (closed || active || latest === null) return;
      const snapshot = latest;
      latest = null;
      lastWriteAt = Date.now();
      active = Promise.resolve().then(() => write(snapshot))
        .catch(() => {
          // Progress is not required for execution correctness. Retry the
          // latest snapshot on the next interval, never an old sequence.
          failures++;
          if (latest === null) latest = snapshot;
        })
        .finally(() => { active = null; schedule(); });
    }, delay);
    timer.unref?.();
  };

  return {
    publish(snapshot) {
      if (closed) throw new Error('native progress writer is closed');
      latest = structuredClone(snapshot);
      schedule();
    },
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      // Unsent snapshots are intentionally discarded: the authoritative
      // final result will be committed after any in-flight write finishes.
      latest = null;
      if (active) await active;
      return { failures };
    },
  };
}
