/**
 * Relay events are execution commands, not an unlimited audit log. Old
 * consumer cursors must never cause expired tool calls to be dispatched.
 */
export function replayCutoff(ttlSeconds, nowMs = Date.now()) {
  const ttl = Number(ttlSeconds);
  const seconds = Number.isFinite(ttl) && ttl > 0 ? ttl : 86400;
  return new Date(nowMs - seconds * 1000).toISOString();
}

export function clampReplayAfter(afterTime, ttlSeconds, nowMs = Date.now()) {
  const cutoff = replayCutoff(ttlSeconds, nowMs);
  const when = Date.parse(afterTime || '');
  return Number.isFinite(when) && when > Date.parse(cutoff)
    ? new Date(when).toISOString() : cutoff;
}

export function isUnexpiredRelayEvent(record, ttlSeconds, nowMs = Date.now()) {
  if (!record || typeof record !== 'object') return false;
  const created = Date.parse(record.create_time || '');
  if (!Number.isFinite(created) || created < Date.parse(replayCutoff(ttlSeconds, nowMs))) return false;
  const expiration = record.expires_at?.toDate?.() ?? record.expires_at;
  const expires = expiration instanceof Date ? expiration.getTime() : Date.parse(expiration || '');
  return !Number.isFinite(expires) || expires > nowMs;
}
