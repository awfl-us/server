// Inactivity TTL, distinct from project lock lease or MCP workspace expiry.
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 60 * 60;
export const MIN_IDLE_TIMEOUT_SECONDS = 60;
export const MAX_IDLE_TIMEOUT_SECONDS = 24 * 60 * 60;

export function resolveIdleTimeoutSeconds(requested, configured = process.env.AWFL_GKE_IDLE_TIMEOUT_SECONDS) {
  const raw = requested ?? configured ?? DEFAULT_IDLE_TIMEOUT_SECONDS;
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds < MIN_IDLE_TIMEOUT_SECONDS ||
      seconds > MAX_IDLE_TIMEOUT_SECONDS) {
    throw new RangeError(
      `idleTimeoutSeconds must be an integer between ${MIN_IDLE_TIMEOUT_SECONDS} and ${MAX_IDLE_TIMEOUT_SECONDS} seconds`,
    );
  }
  return seconds;
}
