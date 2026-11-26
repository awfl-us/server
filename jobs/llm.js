import express from 'express';
import { getDocumentStorage } from '../storage/service.js';
import { getUserIdFromReq, userScopedCollectionPath } from '../workflows/utils.js';
import { decryptString } from '../workflows/crypto.js';

// Provider adapters
import openaiAdapter from './providers/openai.js';
import { supportsResponseStreaming } from './providers/openai.js';
import anthropicAdapter from './providers/anthropic.js';
import geminiAdapter from './providers/gemini.js';
import grokAdapter from './providers/grok.js';
import deepseekAdapter from './providers/deepseek.js';
import { stripNullsDeep } from './providers/utils.js';
import { incrementUsage } from './llm/usage.js';
import { calculateOpenAiCost } from './llm/cost.js';
import { llmFailureResponse } from './llm/transportError.js';
import { MAX_TOKENS, resolveMaxTokens, checkModelContextWindow } from './llm/modelConfig.js';
import { parseTypedToolCalls } from './llm/typedToolArguments.js';

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

  // GPT-6 Sol standard API pricing: input, cached input, output per 1M tokens.
  'gpt-6-sol': { prompt: 2.00, cached: 0.20, completion: 10.00 },
  // GPT-6.1 Terra standard short-context rates (USD per million tokens).
  'gpt-6.1-terra': { prompt: 1.00, cached: 0.05, completion: 5.00 },

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


function fixed_temperature(model, temperature) {
  const fixed = { 'o3': 1, 'gpt-5': 1, 'gpt-5.5': 1 };
  return fixed[model] ?? temperature;
}

function estimateCost(model, usage) {
  // OpenAI prompt_tokens includes cached_tokens; they are not additive.
  return calculateOpenAiCost(PRICING[model] || PRICING['gpt-4'], usage);
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
  const db = await getDocumentStorage();
  const snap = await db.get(userScopedCollectionPath(userId, 'creds') + '/' + providerId);
  if (!snap) return null;
  const data = snap.data || {};
  try {
    return decryptString(data.enc);
  } catch (e) {
    console.error(`[llm] decrypt ${providerId} cred failed:`, e?.message || e);
    throw new Error(`Failed to decrypt stored ${providerId} credential`);
  }
}

// The same router logic is used in Jobs and in isolated HTTP integration tests.
// Production uses the real credential store, provider adapters and usage ledger.
export function createLlmRouter({
  apiKeyForUser = getApiKeyForUser,
  adapters = {openai: openaiAdapter, anthropic: anthropicAdapter,
    gemini: geminiAdapter, grok: grokAdapter, deepseek: deepseekAdapter},
  recordUsage = incrementUsage,
  responseStreamFactory = null
} = {}) {
const router = express.Router();

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
  let liveResponse = null;
  try {
    const userId = await getUserIdFromReq(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized: missing or invalid user' });
    }

    const { messages, model = 'gpt-4', temperature = 0.7, max_tokens, max_completion_tokens, response_format, tools, tool_choice, sessionId, workflow_name, validate_tool_arguments = false, stream_response = false } = req.body || {};

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Missing or invalid "messages" array in request body.' });
    }

    const provider = inferProvider(model);
    const apiKey = await apiKeyForUser(userId, provider);
    if (!apiKey) {
      return res.status(400).json({
        error: `Missing ${provider} credential for user. Set it via POST /workflows/creds/${provider} with { value: "<api-key>" }.`
      });
    }

    const resolvedMaxTokens = (max_completion_tokens ?? max_tokens) ?? resolveMaxTokens(model);

    if (provider === 'openai') {
      const windowCheck = checkModelContextWindow(model, {
        messages, tools, response_format, tool_choice,
        maxCompletionTokens: resolvedMaxTokens
      });
      if (!windowCheck.ok) {
        return res.status(400).json({ error: windowCheck.reason, model });
      }
    }

    const params = stripNullsDeep({
      apiKey,
      model,
      messages: messages.map(m=>{if(!m||typeof m!=='object'||Array.isArray(m))return m;const {responseId,...wire}=m;return wire;}),
      temperature: fixed_temperature(model, temperature),
      max_tokens: resolvedMaxTokens,
      response_format,
      tools,
      tool_choice
    });

    if (responseStreamFactory && stream_response === true && provider === 'openai' &&
        supportsResponseStreaming(params) && typeof sessionId === 'string' && sessionId && req.projectId) {
      try {
        liveResponse = await responseStreamFactory({scope:{userId,projectId:req.projectId,sessionId}});
      } catch {
        // Live transport is optional; preserve the normal inference path.
        console.warn('[llm] response stream unavailable');
      }
    }
    const result = await (adapters[provider] || adapters.openai).chat(params, liveResponse ? {onDelta:liveResponse.onDelta} : undefined);

    const { message, usage, failure } = result || {};
    const total_cost = provider === 'openai' ? estimateCost(model, usage) : null;

    // New typed-tool callers may explicitly opt in. Existing agent tool
    // routing and response behavior remain unchanged. Do not return or log
    // potentially sensitive raw model arguments on validation failure.
    let typedToolError = null;
    if (!failure && validate_tool_arguments === true) {
      try {
        // Validate the exact tools sent to the provider after stripping legacy
        // nullable schema metadata (ToolDefProperty enum/items/required).
        parseTypedToolCalls(message, params.tools || []);
      } catch (err) {
        typedToolError = err instanceof Error ? err.message : 'Invalid tool arguments';
      }
    }

    // Best-effort usage aggregation (graceful no-op if missing context)
    try {
      const projectId = req.projectId; // from middleware/header
      await recordUsage({
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

    // Responses can return a billable terminal failure with HTTP 200 upstream.
    // Account for it once, then fail closed without returning partial tools.
    if (failure) {
      liveResponse?.fail(failure);
      return res.status(502).json({ error: 'LLM response did not complete successfully', code: failure, total_cost });
    }

    // Validation happens after inference, so the failed typed completion is
    // still billed and saved in usage accounting before returning HTTP 422.
    if (typedToolError) {
      liveResponse?.fail('invalid_tool_arguments');
      // Emit only schema field paths/constraint diagnostics, never raw arguments.
      console.warn('[llm] typed tool validation failed', JSON.stringify({
        event: 'awfl_typed_tool_validation_failed',
        model, workflowName: workflow_name || null, reason: typedToolError
      }));
      return res.status(422).json({
        error: 'Typed tool arguments failed validation', reason: typedToolError,
        total_cost
      });
    }
    if(liveResponse && message) {
      liveResponse.finish(message);
      res.status(200).json({ message:{...message,responseId:liveResponse.responseId}, usage, total_cost });
    } else {
      liveResponse?.fail('empty_response');
      res.status(200).json({ message, usage, total_cost });
    }
  } catch (error) {
    liveResponse?.fail('provider_error');
    // Do not log the provider error object wholesale: it can contain
    // response headers (including cookies). Keep searchable safe fields.
    console.error('[llm] chat failed', JSON.stringify({
      event: 'awfl_llm_chat_failed',
      providerStatus: error?.status ?? null,
      providerCode: error?.code ?? error?.error?.code ?? null,
      providerRequestId: error?.request_id ?? null,
      model: req.body?.model ?? null,
      errorMessage: error?.message ?? String(error),
    }));
    const response = llmFailureResponse(error);
    res.status(response.status).json(response.body);
  }
});

return router;
}

export default createLlmRouter();