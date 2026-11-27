import { OPENCODE_MODELS, canonicalModel } from './opencodeModels.js';

// Model limits shared by the LLM transport and the TopicContext size limiter.
// maxCompletionTokens is the existing server default, not a promised output size.
// contextMessageBudgetTokens is an AWFL limit for history *only*; full requests
// additionally contain prompts, tool definitions, protocol overhead and output.
export const MODEL_CONFIGS = Object.freeze({
  'gpt-4o': { maxCompletionTokens: 16384 },
  'chatgpt-4o-latest': { maxCompletionTokens: 16384 },
  'gpt-4-turbo': { maxCompletionTokens: 4096 },
  'gpt-4.1': { maxCompletionTokens: 32768 },
  'gpt-4': { maxCompletionTokens: 8192 },
  'gpt-4-32k': { maxCompletionTokens: 4096 },
  'gpt-3.5-turbo': { maxCompletionTokens: 4096 },
  'gpt-3.5-turbo-16k': { maxCompletionTokens: 4096 },
  'o4-mini': { maxCompletionTokens: 100000 },
  'o3': { maxCompletionTokens: 100000 },
  'gpt-5': { maxCompletionTokens: 128000 },
  'gpt-5.1': { maxCompletionTokens: 128000 },
  'gpt-5.2': { maxCompletionTokens: 128000 },
  'gpt-5.4': { maxCompletionTokens: 128000 },
  'gpt-5.5': { maxCompletionTokens: 128000 },
  'gpt-6.1-terra': {
    maxCompletionTokens: 128000,
    contextWindowTokens: 1050000,
    contextMessageBudgetTokens: 17000 // Temporary threshold/caching regression test
  },
  'claude-3-5-sonnet': { maxCompletionTokens: 8192 },
  'claude-3-opus': { maxCompletionTokens: 8192 },
  'claude-3-haiku': { maxCompletionTokens: 8192 },
  'gemini-1.5-pro': { maxCompletionTokens: 8192 },
  'gemini-1.5-flash': { maxCompletionTokens: 8192 },
  'gemini-2.0-flash': { maxCompletionTokens: 8192 },
  'grok-2': { maxCompletionTokens: 8192 },
  'grok-2-mini': { maxCompletionTokens: 8192 },
  'deepseek-chat': { maxCompletionTokens: 8192 },
  'deepseek-reasoner': { maxCompletionTokens: 8192 },
  ...OPENCODE_MODELS
});

export const MAX_TOKENS = Object.freeze(Object.fromEntries(
  Object.entries(MODEL_CONFIGS).map(([name, config]) => [name, config.maxCompletionTokens])
));

export function resolveMaxTokens(model, fallback = 16384) {
  return MODEL_CONFIGS[canonicalModel(model)]?.maxCompletionTokens || fallback;
}

export const DEFAULT_CONTEXT_MESSAGE_BUDGET_TOKENS = 17000;
// Conservative allowance for prompts and function tools beyond TopicContext's
// own history, and token-counting error. The provider remains authoritative.
export const CONTEXT_INPUT_RESERVE_TOKENS = 32000;

export function resolveContextMessageBudget(model, requestedMaxTokens) {
  const config = MODEL_CONFIGS[canonicalModel(model)];
  const defaultBudget = config?.contextMessageBudgetTokens ??
    DEFAULT_CONTEXT_MESSAGE_BUDGET_TOKENS;
  const requested = Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0
    ? requestedMaxTokens : defaultBudget;
  if (!config?.contextWindowTokens) return requested;

  const safeWindow = Math.max(1, config.contextWindowTokens -
    config.maxCompletionTokens - CONTEXT_INPUT_RESERVE_TOKENS);
  return Math.floor(Math.min(requested, defaultBudget, safeWindow));
}

// Conservative preflight for supported models. This counts *bytes*, not
// estimated tokens, and includes function schemas and completion reservation.
// It is intentionally stricter than real tokenization; OpenAI validates the
// exact model-side token count.
export function checkModelContextWindow(model, body) {
  const config = MODEL_CONFIGS[canonicalModel(model)];
  if (!config?.contextWindowTokens) return { ok: true };
  const output = body.maxCompletionTokens ?? resolveMaxTokens(model);
  if (!Number.isInteger(output) || output < 1 || output > config.maxCompletionTokens) {
    return { ok: false, reason: 'Invalid max completion tokens for selected model' };
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const payload = { messages, tools, response_format: body.response_format, tool_choice: body.tool_choice };
  const inputUpperEstimate = Buffer.byteLength(JSON.stringify(payload), 'utf8') +
    16 * (messages.length + tools.length) + 4096;
  if (inputUpperEstimate + output > config.contextWindowTokens) {
    return { ok: false, reason: 'Request exceeds the configured model context window',
      inputUpperEstimate, maxCompletionTokens: output };
  }
  return { ok: true, inputUpperEstimate, maxCompletionTokens: output };
}
