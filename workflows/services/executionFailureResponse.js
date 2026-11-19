// Normalize GCP / native execution errors at the public HTTP boundary.
// In particular, a compiled EventHandler 409 is a rejected (not queued)
// session turn. Clients must preserve its draft and offer a manual retry.
export function executionFailureResponse({ executionName, state, error }) {
  const code = typeof error?.code === 'number' ? error.code : null;
  const busy = state === 'FAILED' && code === 409;
  const message = typeof error === 'string' ? error :
    typeof error?.message === 'string' ? error.message :
    'Execution did not succeed';
  return {
    status: busy ? 409 : 500,
    body: {
      executionName, state,
      error: message.slice(0, 512),
      ...(busy ? { code: 409, retryable: true } : {}),
    },
  };
}
