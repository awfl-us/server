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

