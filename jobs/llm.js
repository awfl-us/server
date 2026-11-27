import express from 'express';
import { getDocumentStorage } from '../storage/service.js';
import { getUserIdFromReq, userScopedCollectionPath } from '../workflows/utils.js';
import { decryptString } from '../workflows/crypto.js';

// Provider adapters
import openaiAdapter from './providers/openai.js';
import { supportsResponseStreaming } from './providers/openai.js';
import { createConfiguredResponseStream } from '../workflows/events/liveResponseService.js';
import anthropicAdapter from './providers/anthropic.js';
import geminiAdapter from './providers/gemini.js';
import grokAdapter from './providers/grok.js';
import deepseekAdapter from './providers/deepseek.js';
import opencodeAdapter, { supportsOpenCodeStreaming } from './providers/opencode.js';
import { canonicalModel } from './llm/opencodeModels.js';
import { candidatesFor, selectProvider } from './llm/providerRouting.js';
import { OPENAI_PRICING as PRICING, ratesFor } from './llm/providerPricing.js';
import { stripNullsDeep } from './providers/utils.js';
import { incrementUsage } from './llm/usage.js';
import { calculateOpenAiCost } from './llm/cost.js';
import { llmFailureResponse } from './llm/transportError.js';
import { resolveMaxTokens, checkModelContextWindow } from './llm/modelConfig.js';
import { modelCatalog } from './llm/modelCatalog.js';
import { parseTypedToolCalls } from './llm/typedToolArguments.js';

function fixed_temperature(model, temperature) {
  const fixed = { 'o3': 1, 'gpt-5': 1, 'gpt-5.5': 1 };
  return fixed[model] ?? temperature;
}

function estimateCost(model, usage) {
  // OpenAI prompt_tokens includes cached_tokens; they are not additive.
  return calculateOpenAiCost(PRICING[model] || PRICING['gpt-4'], usage);
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
    gemini: geminiAdapter, grok: grokAdapter, deepseek: deepseekAdapter, opencode: opencodeAdapter},
  recordUsage = incrementUsage,
  responseStreamFactory = null
} = {}) {
const router = express.Router();

router.get('/models', (_req, res) => res.status(200).json(modelCatalog()));

router.post('/chat', async (req, res) => {
  let liveResponse = null;
  try {
    const userId = await getUserIdFromReq(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized: missing or invalid user' });
    }

    const { messages, model: requestedModel = 'gpt-4', temperature = 0.7, max_tokens, max_completion_tokens, response_format, tools, tool_choice, sessionId, workflow_name, validate_tool_arguments = false, stream_response = false } = req.body || {};

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Missing or invalid "messages" array in request body.' });
    }

    const model = canonicalModel(requestedModel);
    if (!candidatesFor(model).length) return res.status(400).json({ error: 'Unsupported model', model: requestedModel });
    const resolvedMaxTokens = (max_completion_tokens ?? max_tokens) ?? resolveMaxTokens(model);
    const windowCheck = checkModelContextWindow(model, {
      messages, tools, response_format, tool_choice, maxCompletionTokens: resolvedMaxTokens
    });
    if (!windowCheck.ok) return res.status(400).json({ error: windowCheck.reason, model });
    const now = new Date();
    const selection = await selectProvider({ model, now,
      request: { messages, tools, response_format, maxCompletionTokens: resolvedMaxTokens },
      apiKeyForUser: provider => apiKeyForUser(userId, provider),
      availableProviders: Object.keys(adapters)
    });
    if (!selection) {
      const providers = candidatesFor(model).map(r => r.provider).join(', ');
      return res.status(400).json({ error: `No compatible provider credential for ${model}. Configure a supported provider in Settings (${providers}).` });
    }
    const { provider, apiKey, upstreamModel } = selection;

    const params = stripNullsDeep({
      apiKey,
      model: upstreamModel,
      messages: messages.map(m=>{if(!m||typeof m!=='object'||Array.isArray(m))return m;const {responseId,...wire}=m;return wire;}),
      temperature: fixed_temperature(model, temperature),
      max_tokens: resolvedMaxTokens,
      response_format,
      tools,
      tool_choice
    });

    const canStream = provider === 'openai' ? supportsResponseStreaming(params)
      : provider === 'opencode' && supportsOpenCodeStreaming(params);
    if (responseStreamFactory && stream_response === true && canStream && typeof sessionId === 'string' && sessionId && req.projectId) {
      try {
        liveResponse = await responseStreamFactory({scope:{userId,projectId:req.projectId,sessionId}});
      } catch {
        // Live transport is optional; preserve the normal inference path.
        console.warn('[llm] response stream unavailable');
      }
    }
    const adapter = adapters[provider];
    if (!adapter) throw new Error('Provider adapter unavailable');
    const result = await adapter.chat(params, liveResponse ? {onDelta:liveResponse.onDelta} : undefined);

    const { message, usage, failure } = result || {};
    const rates = ratesFor(provider, model, { now, inputTokens: usage?.prompt_tokens ?? 0 });
    const total_cost = provider === 'opencode' ? (result?.totalCost ?? null)
      : rates ? calculateOpenAiCost(rates, usage)
      : provider === 'openai' ? estimateCost(model, usage) : null;

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
      res.status(200).json({ message:{...message,responseId:liveResponse.responseId}, usage, total_cost, provider, model });
    } else {
      liveResponse?.fail('empty_response');
      res.status(200).json({ message, usage, total_cost, provider, model });
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

export default createLlmRouter({responseStreamFactory:createConfiguredResponseStream});