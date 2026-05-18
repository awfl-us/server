import express from 'express'

const router = express.Router()

// Pricing per 1,000,000 tokens in USD (OpenAI only for now)
const PRICING = {
  'gpt-3.5-turbo': { prompt: 0.50, completion: 1.50 },
  'gpt-3.5-turbo-16k': { prompt: 3.00, completion: 4.00 },
  'gpt-4': { prompt: 30.00, completion: 60.00 },
  'gpt-4-32k': { prompt: 60.00, completion: 120.00 },
  'gpt-4-turbo': { prompt: 10.00, completion: 30.00 },
  'gpt-4o': { prompt: 2.50, completion: 10.00 },
  'chatgpt-4o-latest': { prompt: 5.00, completion: 10.00 },
  'gpt-4o-mini': { prompt: 0.15, completion: 0.60 },
  'gpt-4.1': { prompt: 2.00, completion: 8.00 },
  'gpt-4.1-mini': { prompt: 0.40, completion: 1.60 },
  'gpt-4.1-nano': { prompt: 0.10, completion: 0.40 },
  'gpt-4.5': { prompt: 75.00, completion: 150.00 },
  'o1': { prompt: 15.00, completion: 60.00 },
  'o3': { prompt: 2.00, completion: 8.00 },
  'gpt-5': { prompt: 1.25, completion: 10.00 },
  'gpt-5.1': { prompt: 1.25, completion: 10.00 },
  'gpt-5.2': { prompt: 1.75, completion: 14.00 }
}

// Max completion token defaults per known models/providers
const MAX_TOKENS = {
  // OpenAI
  'gpt-4o': 16384,
  'chatgpt-4o-latest': 16384,
  'gpt-4-turbo': 4096,
  'gpt-4.1': 32768,
  'gpt-4': 8192,
  'gpt-4-32k': 4096,
  'gpt-3.5-turbo': 4096,
  'gpt-3.5-turbo-16k': 4096,
  'o4-mini': 100000,
  'o3': 100000,
  'gpt-5': 128000,
  'gpt-5.1': 128000,
  'gpt-5.2': 128000,
  // Anthropic (conservative completion caps)
  'claude-3-5-sonnet': 8192,
  'claude-3-opus': 8192,
  'claude-3-haiku': 8192,
  // Gemini
  'gemini-1.5-pro': 8192,
  'gemini-1.5-flash': 8192,
  'gemini-2.0-flash': 8192,
  // xAI Grok
  'grok-2': 8192,
  'grok-2-mini': 8192,
  // DeepSeek
  'deepseek-chat': 8192,
  'deepseek-reasoner': 8192
}

router.get('/models', (_req, res) => {
  const providers = [
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
  ]

  const inference = {
    default_provider: 'openai',
    rules: [
      { provider: 'anthropic', match: 'claude-*' },
      { provider: 'gemini', match: 'gemini-*' },
      { provider: 'grok', match: 'grok-*' },
      { provider: 'deepseek', match: 'deepseek-*' },
      { provider: 'openai', match: 'gpt-*, chatgpt-*, o1*, o3*, o4*, gpt-5*' }
    ]
  }

  res.status(200).json({
    providers,
    inference,
    known_models: Object.keys(MAX_TOKENS),
    max_tokens: MAX_TOKENS,
    pricing: { openai: PRICING }
  })
})

export default router
