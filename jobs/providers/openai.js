import { OpenAI } from 'openai';
import { stripNullsDeep } from './utils.js';

// OpenAI adapter wrapping chat.completions
// Input: { apiKey, model, messages, temperature, max_tokens, response_format, tools, tool_choice }
// Returns: { message, usage, raw }
export function buildChatPayload(params) {
  const { model, messages, temperature, max_tokens, response_format, tools, tool_choice } = params;
  // Chat Completions rejects GPT-6 Sol function calls with reasoning
  // enabled. Use the supported no-reasoning mode for this legacy adapter;
  // Responses API is required to use reasoning-enabled function tools.
  const isSol = model === 'gpt-6-sol';
  const hasFunctionTools = Array.isArray(tools) && tools.some(t => t?.type === 'function');
  return stripNullsDeep({
    model,
    messages,
    temperature: isSol ? undefined : temperature,
    max_completion_tokens: typeof max_tokens === 'number' ? max_tokens : undefined,
    response_format,
    tools,
    tool_choice,
    reasoning_effort: isSol && hasFunctionTools ? 'none' : undefined
  });
}

export async function chat(params) {
  // Retain native fetch: node-fetch prematurely closes compressed GKE replies.
  const client = new OpenAI({ apiKey: params.apiKey, fetch: globalThis.fetch });
  const resp = await client.chat.completions.create(buildChatPayload(params));

  const choice = resp.choices?.[0];
  const message = choice?.message || null;
  const usage = resp.usage || null;
  return { message, usage, raw: resp };
}

export default { chat };
