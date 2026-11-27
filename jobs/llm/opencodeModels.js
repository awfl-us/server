// Explicit paid Console allowlist. Keep direct provider IDs unchanged.
// Context limits verified against https://opencode.ai/inference/v1/models
// on 2026-11-27. AWFL deliberately defaults to a smaller output reservation.
const models = {
  'gpt-6.2-sol': 1050000,
  'gpt-6-luna': 1050000,
  'claude-sonnet-5-5': 1000000,
  'claude-opus-5-5': 1000000,
  'gemini-4-argon': 1048576,
  'gemini-3.8-flash': 1048576,
  'deepseek-v4.1-flash': 1000000,
  'deepseek-v4-pro': 1000000,
  'glm-5.3': 1000000,
  'kimi-k2.7-code': 262144
};

export const OPENCODE_MODELS = Object.freeze(Object.fromEntries(
  Object.entries(models).map(([id, contextWindowTokens]) => [
    'opencode/' + id, Object.freeze({ id, contextWindowTokens, maxCompletionTokens: 32768 })
  ])
));

export const OPENCODE_PROVIDER = Object.freeze({
  id: 'opencode',
  prefixes: ['opencode/'],
  examples: Object.keys(OPENCODE_MODELS)
});

export function getOpenCodeModel(model) {
  return Object.hasOwn(OPENCODE_MODELS, model) ? OPENCODE_MODELS[model] : undefined;
}
