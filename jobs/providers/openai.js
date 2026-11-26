import { OpenAI } from 'openai';
import { captureOpenAiRequest, logOpenAiCacheUsage } from './openaiCapture.js';
import { stripNullsDeep } from './utils.js';
import { toOpenAiMessages } from './openaiMessages.js';
import { buildResponsesPayload, normalizeResponsesResult } from './openaiResponses.js';

// OpenAI adapter wrapping chat.completions
// Input: { apiKey, model, messages, temperature, max_tokens, response_format, tools, tool_choice }
// Returns: { message, usage, raw }
export function buildChatPayload(params) {
  const { model, messages, temperature, max_tokens, response_format, tools, tool_choice } = params;
  // GPT-6 Sol and GPT-6.1 Terra support Chat Completions function tools
  // with reasoning_effort=none; remove unsupported temperature settings.
  const isNoReasoningToolModel = model === 'gpt-6-sol' || model === 'gpt-6.1-terra';
  const hasFunctionTools = Array.isArray(tools) && tools.some(t => t?.type === 'function');
  return stripNullsDeep({
    model,
    messages: toOpenAiMessages(messages),
    temperature: isNoReasoningToolModel ? undefined : temperature,
    max_completion_tokens: typeof max_tokens === 'number' ? max_tokens : undefined,
    response_format,
    tools,
    tool_choice,
    reasoning_effort: isNoReasoningToolModel && hasFunctionTools ? 'none' : undefined
  });
}

// Initially opt in only models whose no-reasoning tool configuration is
// already supported by AWFL. No fallback retry after a provider request.
const responsesCanaryModels = new Set(['gpt-6.1-terra', 'gpt-6-sol']);
export function useResponses(model, configured = process.env.AWFL_OPENAI_RESPONSES_MODELS || '') {
  return responsesCanaryModels.has(model) && configured.split(',').map(s => s.trim()).includes(model);
}

export async function chat(params) {
  // Retain native fetch: node-fetch prematurely closes compressed GKE replies.
  const client = new OpenAI({ apiKey: params.apiKey, fetch: globalThis.fetch });
  const responses = useResponses(params.model);
  const legacy = buildChatPayload(params);
  const payload = responses ? buildResponsesPayload({ ...params, messages: legacy.messages,
    tools: legacy.tools, tool_choice: legacy.tool_choice, response_format: legacy.response_format },
    { reasoningEffort: legacy.reasoning_effort, temperature: legacy.temperature }) : legacy;
  const capture = captureOpenAiRequest(payload);
  const started = Date.now();
  let resp;
  try {
    resp = responses ? await client.responses.create(payload) : await client.chat.completions.create(payload);
  } catch (error) {
    if (capture) console.error(JSON.stringify({ event: 'openai_context_capture_request_failed', capture_id: capture.id, status: error?.status ?? null }));
    throw error;
  }
  if (responses) {
    const result = normalizeResponsesResult(resp);
    logOpenAiCacheUsage(capture, { model: resp.model, _request_id: resp._request_id, usage: result.usage }, Date.now() - started);
    return { ...result, raw: resp };
  }
  logOpenAiCacheUsage(capture, resp, Date.now() - started);

  const choice = resp.choices?.[0];
  const message = choice?.message || null;
  const usage = resp.usage || null;
  return { message, usage, raw: resp };
}

export default { chat };
