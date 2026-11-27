// Paid Console allowlist; model IDs are canonical AWFL IDs, not provider choices.
// Context limits from https://opencode.ai/inference/v1/models (2026-11-27).
const models = {
  'gpt-6.2-sol': 1050000,
  'gpt-6-luna': 1050000,
  'gpt-6-sol': 1050000,
  'gpt-5': 400000,
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
    id, Object.freeze({ id, contextWindowTokens, maxCompletionTokens: id === 'gpt-5' ? 128000 : id === 'gpt-6-sol' ? 16384 : 32768 })
  ])
));

export const OPENCODE_PROVIDER = Object.freeze({
  id: 'opencode', prefixes: [], examples: Object.keys(OPENCODE_MODELS)
});

export function canonicalModel(model) {
  if (typeof model !== 'string') return model;
  if (model === 'deepseek-flash') return 'deepseek-v4.1-flash';
  if (model === 'claude-sonnet-5.5') return 'claude-sonnet-5-5';
  if (model === 'claude-opus-5.5') return 'claude-opus-5-5';
  if (model.startsWith('opencode/') && Object.hasOwn(OPENCODE_MODELS, model.slice(9))) return model.slice(9);
  return model;
}

export function getOpenCodeModel(model) {
  const id = canonicalModel(model);
  return Object.hasOwn(OPENCODE_MODELS, id) ? OPENCODE_MODELS[id] : undefined;
}
