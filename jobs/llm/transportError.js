// Preserve the upstream distinction between exhausted API credits and a
// server crash. A retry cannot succeed until the provider balance changes.
export function llmFailureResponse(error) {
  const code = error?.code ?? error?.error?.code;
  const type = error?.type ?? error?.error?.type;
  if (error?.status === 429 &&
      (code === 'credit_balance_exhausted' || type === 'insufficient_quota')) {
    return {
      status: 429,
      body: {
        error: 'LLM provider credits exhausted',
        code: 'credit_balance_exhausted',
        retryable: false,
      },
    };
  }
  return {
    status: 500,
    body: { error: 'Failed to complete chat request: ' +
      (error?.message || String(error)) },
  };
}
