import { OpenAI } from 'openai';
import { getOpenCodeModel } from '../llm/opencodeModels.js';
import { buildResponsesPayload, normalizeResponsesResult } from './openaiResponses.js';
import { readResponsesStream } from './openaiResponsesStream.js';
import { toOpenAiMessages } from './openaiMessages.js';

// Console translates text models to the OpenAI Responses API. Keep AWFL's
// existing history/tool contract; never send its provider namespace upstream.
export const OPENCODE_BASE_URL = 'https://opencode.ai/inference/openai/v1';

export function supportsOpenCodeStreaming(params) {
  return Boolean(getOpenCodeModel(params.model)) &&
    (!params.response_format || params.response_format.type === 'text') &&
    (params.tool_choice == null || ['auto', 'none'].includes(params.tool_choice));
}

export function openCodeCost(usage) {
  const cost = usage?.cost;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null;
}

export async function chat(params, { fetch = globalThis.fetch, onDelta } = {}) {
  const config = getOpenCodeModel(params.model);
  if (!config) throw new TypeError('Unsupported OpenCode model');
  const client = new OpenAI({ apiKey: params.apiKey, baseURL: OPENCODE_BASE_URL, fetch, maxRetries: 0 });
  const payload = buildResponsesPayload({
    ...params, model: config.id, messages: toOpenAiMessages(params.messages)
  }, {
    // GPT-6 tool loops use the same non-reasoning contract as direct OpenAI.
    reasoningEffort: config.id.startsWith('gpt-6') && params.tools?.length ? 'none' : undefined
  });
  const streaming = typeof onDelta === 'function' && supportsOpenCodeStreaming(params);
  if (streaming) payload.stream = true;
  const response = streaming
    ? await readResponsesStream(await client.responses.create(payload), onDelta)
    : await client.responses.create(payload);
  return { ...normalizeResponsesResult(response), totalCost: openCodeCost(response.usage) };
}

export default { chat };
