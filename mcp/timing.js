// Server-side execution milestones are already stored on each MCP request.
// Expose durations without adding Firestore reads or changing consumer behavior.
export function commandTimingsMs(data, now = Date.now()) {
  const at = key => Number.isFinite(data?.[key]) ? data[key] : null;
  const duration = (start, end) => (
    Number.isFinite(start) && Number.isFinite(end) && end >= start
      ? end - start : null
  );
  const created = at('createdAt');
  const dispatched = at('dispatchedAt');
  const claimed = at('claimedAt');
  const completed = at('completedAt');
  return {
    submission: duration(created, dispatched),
    delivery: duration(dispatched, claimed),
    execution: duration(claimed, completed),
    total: duration(created, completed),
    // While pending/running, this is age. Once completed, it stops increasing.
    elapsed: duration(created, completed ?? now),
  };
}
