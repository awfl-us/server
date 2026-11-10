import { OpenAI } from 'openai';
import { stripNullsDeep } from './utils.js';

// OpenAI adapter wrapping chat.completions
// Input: { apiKey, model, messages, temperature, max_tokens, response_format, tools, tool_choice }
// Returns: { message, usage, raw }
export async function chat(params) {
  const { apiKey, model, messages, temperature, max_tokens, response_format, tools, tool_choice } = params;
  // The v4 SDK defaults to node-fetch 2.x. Its chunked-response close
  // detection can falsely terminate compressed replies in GKE, producing
  // ERR_STREAM_PREMATURE_CLOSE. Native fetch (Node 20+) handles both gzip
  // and Brotli without disabling response compression.
  const client = new OpenAI({ apiKey, fetch: globalThis.fetch });

  // Build request payload and defensively strip null/undefined values
  const payload = stripNullsDeep({
    model,
    messages,
    temperature,
    // OpenAI SDK prefers max_completion_tokens in newer models; accept max_tokens and map
    max_completion_tokens: typeof max_tokens === 'number' ? max_tokens : undefined,
    response_format,
    tools,
    tool_choice
  });

  const resp = await client.chat.completions.create(payload);

  const choice = resp.choices?.[0];
  const message = choice?.message || null;
  const usage = resp.usage || null;
  return { message, usage, raw: resp };
}

export default { chat };
