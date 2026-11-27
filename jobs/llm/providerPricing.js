// Standard public USD per million tokens; verified 2026-11-27.
export const OPENAI_PRICING = {
  // Legacy
  'gpt-4o': { prompt: 2.50, cached: 1.25, completion: 10.00 },
  'chatgpt-4o-latest': { prompt: 5.00, cached: 2.50, completion: 10.00 },
  'gpt-4o-mini': { prompt: 0.15, cached: 0.075, completion: 0.60 },

  'gpt-4.1': { prompt: 2.00, cached: 0.50, completion: 8.00 },
  'gpt-4.1-mini': { prompt: 0.40, cached: 0.10, completion: 1.60 },
  'gpt-4.1-nano': { prompt: 0.10, cached: 0.025, completion: 0.40 },

  // GPT-5 family
  'gpt-5': { prompt: 1.25, cached: 0.125, completion: 10.00 },
  'gpt-5-mini': { prompt: 0.25, cached: 0.025, completion: 2.00 },
  'gpt-5-nano': { prompt: 0.05, cached: 0.005, completion: 0.40 },

  'gpt-5.4': { prompt: 2.50, cached: 0.25, completion: 15.00 },
  'gpt-5.4-mini': { prompt: 0.75, cached: 0.075, completion: 4.50 },
  'gpt-5.4-nano': { prompt: 0.20, cached: 0.02, completion: 1.25 },

  'gpt-5.5': { prompt: 5.00, cached: 0.50, completion: 30.00 },
  'gpt-5.5-pro': { prompt: 30.00, cached: 0.00, completion: 180.00 },

  // GPT-6 Sol standard API pricing: input, cached input, output per 1M tokens.
  'gpt-6-sol': { prompt: 2.00, cached: 0.20, completion: 10.00 },
  // GPT-6.1 Terra standard short-context rates (USD per million tokens).
  'gpt-6.1-terra': { prompt: 1.00, cached: 0.05, completion: 5.00 },

  'gpt-6.2-sol': { prompt: 2, cached: 0.10, completion: 10 },
  'gpt-6-luna': { prompt: 0.10, cached: 0.01, completion: 0.50 },

  // Reasoning
  'o4-mini': { prompt: 0.55, cached: 0.14, completion: 2.20 },
  'o3': { prompt: 2.00, cached: 0.50, completion: 8.00 },
  'o3-mini': { prompt: 1.10, cached: 0.55, completion: 4.40 },
  'o3-pro': { prompt: 20.00, cached: 0.00, completion: 80.00 },

  // Historical models (kept for old logs)
  'gpt-4-turbo': { prompt: 10.00, cached: 0.00, completion: 30.00 },
  'gpt-4': { prompt: 30.00, cached: 0.00, completion: 60.00 },
  'gpt-4-32k': { prompt: 60.00, cached: 0.00, completion: 120.00 },
  'gpt-3.5-turbo': { prompt: 0.50, cached: 0.00, completion: 1.50 },
  'gpt-3.5-turbo-16k': { prompt: 3.00, cached: 0.00, completion: 4.00 }
};

// List price snapshot (not private negotiated rates). Cache writes are not
// requested by AWFL. The published OpenCode discount is reflected here.
const rate = (prompt, cached, completion) => ({ prompt, cached, completion });
export const OPENCODE_PRICING = {
  'gpt-6.2-sol': rate(2,.1,10),
  'gpt-6-luna': rate(.1,.01,.5),
  'gpt-6-sol': rate(2,.2,10),
  'gpt-5': rate(1.07,.107,8.5),
  'claude-sonnet-5-5': rate(2,.1,10),
  'claude-opus-5-5': rate(4,.2,20),
  'gemini-4-argon': rate(2,.1,10),
  'gemini-3.8-flash': rate(.75,.075,3.75),
  'deepseek-v4.1-flash': rate(.12,.0024,.48),
  'deepseek-v4-pro': rate(1.74,.145,3.48),
  'glm-5.3': rate(.56,.104,1.76),
  'kimi-k2.7-code': rate(.95,.19,4)
};
const DIRECT_PRICING = {
  anthropic: {
    'claude-sonnet-5-5': rate(2,.1,10),
    'claude-opus-5-5': rate(4,.2,20)
  },
  gemini: {
    'gemini-4-argon': rate(2,.1,10),
    'gemini-3.8-flash': rate(.75,.075,3.75)
  },
  deepseek: {
    'deepseek-v4.1-flash': rate(.15,.003,.60),
    'deepseek-v4-pro': rate(.66,.022,1.98)
  }
};
export const PROVIDER_PRICING = { openai: OPENAI_PRICING, opencode: OPENCODE_PRICING, ...DIRECT_PRICING };

export function ratesFor(provider, model, { now = new Date(), inputTokens = 0 } = {}) {
  const rates = PROVIDER_PRICING[provider]?.[model];
  if (!rates) return null;
  if ((provider === 'openai' || provider === 'opencode') &&
      ['gpt-6.2-sol','gpt-6-sol','gpt-6-luna','gpt-6.1-terra'].includes(model) && inputTokens > 272000)
    return rate(rates.prompt * 2, rates.cached * 2, rates.completion * 1.5);
  if (provider === 'deepseek') {
    const weekday = now.getUTCDay();
    const hour = now.getUTCHours();
    // Conservative peak estimate: Chinese holidays are not yet modeled.
    if (weekday >= 1 && weekday <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)))
      return rate(rates.prompt * 2, rates.cached * 2, rates.completion * 2);
  }
  if (provider === 'gemini' || provider === 'opencode') {
    const cutoff = model === 'gemini-4-argon' ? '2026-12-01' : model === 'gemini-3.8-flash' ? '2027-01-01' : null;
    if (cutoff && now.toISOString().slice(0,10) >= cutoff)
      return rate(rates.prompt * 2, rates.cached * 2, rates.completion * 2);
  }
  return rates;
}
