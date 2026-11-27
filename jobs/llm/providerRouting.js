import { canonicalModel, getOpenCodeModel } from './opencodeModels.js';
import { ratesFor } from './providerPricing.js';

// Exact model mappings. Never infer that a different model/version is equivalent.
const direct = {
  'gpt-6.2-sol': 'openai',
  'gpt-6-luna': 'openai',
  'gpt-6-sol': 'openai',
  'gpt-5': 'openai',
  'claude-sonnet-5-5': 'anthropic',
  'claude-opus-5-5': 'anthropic',
  'gemini-4-argon': 'gemini',
  'gemini-3.8-flash': 'gemini',
  'deepseek-v4.1-flash': 'deepseek',
  'deepseek-v4-pro': 'deepseek'
};

function legacyProvider(model) {
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gemini-') || model.includes('gemini')) return 'gemini';
  if (model.startsWith('grok-')) return 'grok';
  if (model.startsWith('deepseek-')) return 'deepseek';
  return 'openai';
}

export function candidatesFor(requestedModel) {
  const model = canonicalModel(requestedModel);
  if (typeof model !== 'string' || !model || model.includes('/')) return [];
  if (!getOpenCodeModel(model)) return [{ provider: legacyProvider(model), model, upstreamModel: model }];
  const providers = [];
  if (Object.hasOwn(direct, model)) providers.push({
    provider: direct[model], model, upstreamModel: model === 'deepseek-v4.1-flash' ? 'deepseek-flash' : model
  });
  providers.push({ provider: 'opencode', model, upstreamModel: model });
  return providers;
}

function compatible(route, request) {
  // The existing direct Anthropic/Gemini adapters drop tool history and schemas.
  // For the new overlapping catalog, never route those requests to text-only adapters.
  if (getOpenCodeModel(route.model) && ['anthropic','gemini'].includes(route.provider)) {
    return !request.tools?.length && !request.messages?.some(m => m?.role === 'tool' || m?.tool_calls?.length) &&
      (!request.response_format || request.response_format.type === 'text');
  }
  return true;
}

// Compare estimated standard request cost: cold input + expected output.
// Actual completion and cache hits cannot be known before inference. Ties
// favor direct providers (no gateway hop, preserve existing prompt caches).
export async function selectProvider({ model, request, apiKeyForUser, now = new Date(), availableProviders }) {
  const routes = candidatesFor(model).filter(r => compatible(r, request) &&
    (!availableProviders || availableProviders.includes(r.provider)));
  const inputTokens = Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify({
    messages: request.messages, tools: request.tools, response_format: request.response_format
  }), 'utf8') / 4));
  const outputTokens = Math.min(request.maxCompletionTokens ?? 16384, Math.max(1, Math.ceil(inputTokens * .1)));
  const ranked = routes.map(r => {
    const rates = ratesFor(r.provider, r.model, { now, inputTokens });
    return { ...r, estimatedCost: rates ? (inputTokens * rates.prompt + outputTokens * rates.completion) / 1e6 : Infinity };
  }).sort((a,b) => a.estimatedCost - b.estimatedCost);
  // Read only candidates in price order and stop when a key exists.
  for (const route of ranked) {
    const apiKey = await apiKeyForUser(route.provider);
    if (apiKey) return { ...route, apiKey };
  }
  return null;
}
