import express from 'express';
import { getFirestore } from 'firebase-admin/firestore';
import { getUserIdFromReq, userScopedCollectionPath } from '../workflows/utils.js';
import { decryptString } from '../workflows/crypto.js';

// Provider adapters
import openaiAdapter from './providers/openai.js';
import anthropicAdapter from './providers/anthropic.js';
import geminiAdapter from './providers/gemini.js';
import grokAdapter from './providers/grok.js';
import deepseekAdapter from './providers/deepseek.js';
import { stripNullsDeep } from './providers/utils.js';
import { incrementUsage } from './llm/usage.js';

const router = express.Router();
const db = getFirestore();

// Pricing per 1,000,000 tokens in USD (OpenAI only for now)
// USD per 1,000,000 tokens
const PRICING = {
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
  'gpt-5.4': 128000,
  'gpt-5.5': 128000,
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
};

function fixed_temperature(model, temperature) {
  const fixed = { 'o3': 1, 'gpt-5': 1, 'gpt-5.5': 1 };
  return fixed[model] ?? temperature;
}

function estimateCost(model, usage) {
  const m = PRICING[model] || PRICING['gpt-4'];
  if (!usage) return null;
  return (
    ((usage.prompt_tokens || 0) / 1_000_000) * (m.prompt || 0) +
    ((usage.prompt_tokens_details?.cached_tokens || 0) / 1_000_000) * (m.cached || 0) +
    ((usage.completion_tokens || 0) / 1_000_000) * (m.completion || 0)
  );
}

function resolveMaxTokens(model, fallback = 16384) {
  return MAX_TOKENS[model] || fallback;
}

function inferProvider(model = '') {
  const m = (model || '').toLowerCase();
  if (m.startsWith('claude-')) return 'anthropic';
  if (m.startsWith('gemini-') || m.includes('gemini')) return 'gemini';
  if (m.startsWith('grok-')) return 'grok';
  if (m.startsWith('deepseek-')) return 'deepseek';
  // Default to OpenAI (gpt-, chatgpt-, o1/o3, etc.)
  return 'openai';
}

async function getApiKeyForUser(userId, providerId) {
  const docRef = db.collection(userScopedCollectionPath(userId, 'creds')).doc(providerId);
  const snap = await docRef.get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  try {
    return decryptString(data.enc);
  } catch (e) {
    console.error(`[llm] decrypt ${providerId} cred failed:`, e?.message || e);
    throw new Error(`Failed to decrypt stored ${providerId} credential`);
  }
}

// List supported model prefixes and known models
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
  ];

  const inference = {
    default_provider: 'openai',
    rules: [
      { provider: 'anthropic', match: 'claude-*' },
      { provider: 'gemini', match: 'gemini-*' },
      { provider: 'grok', match: 'grok-*' },
      { provider: 'deepseek', match: 'deepseek-*' },
      { provider: 'openai', match: 'gpt-*, chatgpt-*, o1*, o3*, o4*, gpt-5*' }
    ]
  };

  res.status(200).json({
    providers,
    inference,
    known_models: Object.keys(MAX_TOKENS),
    max_tokens: MAX_TOKENS,
    pricing: { openai: PRICING }
  });
});

router.post('/chat', async (req, res) => {
  try {
    const userId = await getUserIdFromReq(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized: missing or invalid user' });
    }

    const { messages, model = 'gpt-4', temperature = 0.7, max_tokens, max_completion_tokens, response_format, tools, tool_choice, sessionId, workflow_name } = req.body || {};

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Missing or invalid "messages" array in request body.' });
    }

    const provider = inferProvider(model);
    const apiKey = await getApiKeyForUser(userId, provider);
    if (!apiKey) {
      return res.status(400).json({
        error: `Missing ${provider} credential for user. Set it via POST /workflows/creds/${provider} with { value: "<api-key>" }.`
      });
    }

    const resolvedMaxTokens = (max_completion_tokens ?? max_tokens) ?? resolveMaxTokens(model);

    const params = stripNullsDeep({
      apiKey,
      model,
      messages,
      temperature: fixed_temperature(model, temperature),
      max_tokens: resolvedMaxTokens,
      response_format,
      tools,
      tool_choice
    });

    let result;
    switch (provider) {
      case 'anthropic':
        result = await anthropicAdapter.chat(params);
        break;
      case 'gemini':
        result = await geminiAdapter.chat(params);
        break;
      case 'grok':
        result = await grokAdapter.chat(params);
        break;
      case 'deepseek':
        result = await deepseekAdapter.chat(params);
        break;
      case 'openai':
      default:
        result = await openaiAdapter.chat(params);
        break;
    }

    const { message, usage } = result || {};
    const total_cost = provider === 'openai' ? estimateCost(model, usage) : null;

    // Best-effort usage aggregation (graceful no-op if missing context)
    try {
      const projectId = req.projectId; // from middleware/header
      await incrementUsage({
        userId,
        projectId,
        sessionId,
        workflowName: workflow_name,
        usage,
        totalCost: typeof total_cost === 'number' ? total_cost : undefined,
        timestamp: Date.now()
      });
    } catch (e) {
      console.warn('[llm] incrementUsage failed (non-fatal):', e?.message || e);
    }

    res.status(200).json({ message, usage, total_cost });
  } catch (error) {
    console.error('LLM chat error:', error);
    res.status(500).json({ error: 'Failed to complete chat request: ' + (error?.message || String(error)) });
  }
});

export default router;