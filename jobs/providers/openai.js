import { OpenAI } from 'openai';
import { captureOpenAiRequest, logOpenAiCacheUsage } from './openaiCapture.js';
import { stripNullsDeep } from './utils.js';
import { toOpenAiMessages } from './openaiMessages.js';
import { buildResponsesPayload, normalizeResponsesResult } from './openaiResponses.js';
import { readResponsesStream } from './openaiResponsesStream.js';

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

// Validated models use Responses by default on both Cloud Run and native Jobs.
// An explicitly empty environment override restores Chat Completions.
// No fallback retry after a provider request.
const validatedResponsesModels = ['gpt-6.1-terra', 'gpt-6-sol'];
export function useResponses(model, configured = process.env.AWFL_OPENAI_RESPONSES_MODELS ?? validatedResponsesModels.join(',')) {
  return validatedResponsesModels.includes(model) && configured.split(',').map(s => s.trim()).includes(model);
}

export function supportsResponseStreaming(params) {
  return useResponses(params.model) &&
    (!params.response_format || params.response_format.type === 'text') &&
    (params.tool_choice == null || ['auto','none'].includes(params.tool_choice));
}

export async function chat(params, { fetch = globalThis.fetch, onDelta } = {}) {
  // Retain native fetch: node-fetch prematurely closes compressed GKE replies.
  const client = new OpenAI({ apiKey: params.apiKey, fetch });
  const responses = useResponses(params.model);
  const legacy = buildChatPayload(params);
  const payload = responses ? buildResponsesPayload({ ...params, messages: legacy.messages,
    tools: legacy.tools, tool_choice: legacy.tool_choice, response_format: legacy.response_format },
    { reasoningEffort: legacy.reasoning_effort, temperature: legacy.temperature }) : legacy;
  const streaming = typeof onDelta === 'function' && supportsResponseStreaming(params);
  if (streaming) payload.stream = true;
  const capture = captureOpenAiRequest(payload);
  const started = Date.now();
  let resp, requestId;
  try {
    if (streaming) {
      const { data, request_id } = await client.responses.create(payload).withResponse();
      requestId = request_id;
      resp = await readResponsesStream(data, onDelta);
    } else {
      resp = responses ? await client.responses.create(payload) : await client.chat.completions.create(payload);
    }
  } catch (error) {
    if (capture) console.error(JSON.stringify({ event: 'openai_context_capture_request_failed', capture_id: capture.id, status: error?.status ?? null }));
    throw error;
  }
  if (responses) {
    const result = normalizeResponsesResult(resp);
    logOpenAiCacheUsage(capture, { model: resp.model, _request_id: requestId ?? resp._request_id, usage: result.usage }, Date.now() - started);
    return { ...result, raw: resp };
  }
  logOpenAiCacheUsage(capture, resp, Date.now() - started);

  const choice = resp.choices?.[0];
  const message = choice?.message || null;
  const usage = resp.usage || null;
  return { message, usage, raw: resp };
}

export default { chat };
