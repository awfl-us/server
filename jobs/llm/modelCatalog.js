import { OPENCODE_PROVIDER } from './opencodeModels.js';
import { candidatesFor } from './providerRouting.js';
import { MAX_TOKENS } from './modelConfig.js';
import { PROVIDER_PRICING } from './providerPricing.js';

export function modelCatalog() {
  const providers = [
    OPENCODE_PROVIDER,
    {
      id: 'openai',
      prefixes: ['gpt-', 'chatgpt-', 'o1', 'o3', 'o4', 'gpt-5'],
      examples: ['gpt-4o', 'chatgpt-4o-latest', 'o3']
    },
    {
      id: 'anthropic',
      prefixes: ['claude-'],
      examples: ['claude-3-5-sonnet']
    },
    {
      id: 'gemini',
      prefixes: ['gemini-'],
      examples: ['gemini-1.5-pro']
    },
    {
      id: 'grok',
      prefixes: ['grok-'],
      examples: ['grok-2']
    },
    {
      id: 'deepseek',
      prefixes: ['deepseek-'],
      examples: ['deepseek-chat']
    }
  ];

  const inference = {
    default_provider: 'openai',
    strategy: 'lowest_estimated_cost_with_credential',
    rules: [
      { provider: 'opencode', match: 'catalog-supported models' },
      { provider: 'anthropic', match: 'claude-*' },
      { provider: 'gemini', match: 'gemini-*' },
      { provider: 'grok', match: 'grok-*' },
      { provider: 'deepseek', match: 'deepseek-*' },
      { provider: 'openai', match: 'gpt-*, chatgpt-*, o1*, o3*, o4*, gpt-5*' }
    ]
  };

  return {
    providers,
    inference,
    known_models: Object.keys(MAX_TOKENS),
    max_tokens: MAX_TOKENS,
    pricing: PROVIDER_PRICING,
    pricing_as_of: '2026-11-27',
    model_providers: Object.fromEntries(Object.keys(MAX_TOKENS).map(model => [model, candidatesFor(model).map(r => r.provider)]))
  };
}

