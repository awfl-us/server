// Log failure context without workflow arguments, credentials, or unbounded stacks.
// The workflow's catchable error contract remains unchanged.
export function diagnosticText(value, maxLength = 2048) {
  return String(value ?? '')
    .replace(/((?:Bearer|Basic)\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|api_key|access_token|key|secret|password)=)[^&\s]+/gi,
      '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*)[^\s,;]+/gi,
      '$1[REDACTED]')
    .slice(0, maxLength);
}


// Bounded, redacted error for a compiled Try continuation. Keep the operation
// and effect identity so the persisted exception is searchable in Cloud Logs.
// This changes only presentation; it does not classify uncertain outcomes as
// confirmed or change any retry/reconciliation decision.
export function catchableEffectFailure(error, operation, effectId) {
  const nested = error?.nativeError;
  const raw = nested ?? error;
  const httpCode = error?.response?.status ?? error?.status ?? null;
  const code = Number.isSafeInteger(httpCode) && httpCode >= 400 && httpCode <= 599
    ? httpCode : Number.isSafeInteger(raw?.code) && raw.code >= 400 && raw.code <= 599
      ? raw.code : null;
  const original = typeof raw === 'string' ? raw : raw?.message ?? error?.message;
  const reason = diagnosticText(code
    ? `HTTP ${code}${original && original !== `HTTP ${code}` ? `: ${original}` : ''}`
    : original || error?.name || 'effect execution failed', 192);
  const label = `${operation} (${effectId}): `;
  return { message: (label + reason).slice(0, 256), code };
}
