import { OpenAI } from 'openai';
import { captureOpenAiRequest, logOpenAiCacheUsage } from './openaiCapture.js';
import { stripNullsDeep } from './utils.js';
import { toOpenAiMessages } from './openaiMessages.js';

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

export async function chat(params) {
  // Retain native fetch: node-fetch prematurely closes compressed GKE replies.
  const client = new OpenAI({ apiKey: params.apiKey, fetch: globalThis.fetch });
  const payload = buildChatPayload(params);
  const capture = captureOpenAiRequest(payload);
  const started = Date.now();
  let resp;
  try {
    resp = await client.chat.completions.create(payload);
  } catch (error) {
    if (capture) console.error(JSON.stringify({ event: 'openai_context_capture_request_failed', capture_id: capture.id, status: error?.status ?? null }));
    throw error;
  }
  logOpenAiCacheUsage(capture, resp, Date.now() - started);

  const choice = resp.choices?.[0];
  const message = choice?.message || null;
  const usage = resp.usage || null;
  return { message, usage, raw: resp };
}

export default { chat };
