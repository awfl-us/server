/** Prices are dollars per million tokens.
 * Chat Completions cached input tokens are included in prompt_tokens.
 */
export function calculateOpenAiCost(rates, usage) {
  if (!usage) return null;
  const prompt = Math.max(0, Number(usage.prompt_tokens) || 0);
  const cached = Math.min(prompt, Math.max(0, Number(usage.prompt_tokens_details?.cached_tokens) || 0));
  const completion = Math.max(0, Number(usage.completion_tokens) || 0);
  return ((prompt - cached) * rates.prompt + cached * rates.cached
    + completion * rates.completion) / 1_000_000;
}
