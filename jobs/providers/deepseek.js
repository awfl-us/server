import axios from 'axios';
import { toOpenAiMessages } from './openaiMessages.js';

// DeepSeek - largely OpenAI-compatible chat completions API
// Endpoint base: https://api.deepseek.com/v1
// Input: { apiKey, model, messages, temperature, max_tokens, response_format, tools, tool_choice }
// Returns: { message, usage, raw }
export async function chat(params) {
  const { apiKey, model, messages, temperature, max_tokens, response_format, tools, tool_choice } = params;
  const body = {
    model,
    messages: toOpenAiMessages(messages),
    temperature,
    max_tokens,
    response_format,
    tools,
    tool_choice,
    ...(['deepseek-flash','deepseek-v4-pro'].includes(model) ? { thinking: { type: 'disabled' } } : {})
  };

  const resp = await axios.post('https://api.deepseek.com/v1/chat/completions', body, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    timeout: 60_000
  });

  const data = resp.data;
  const choice = data.choices?.[0];
  const message = choice?.message || null;
  const usage = data.usage ? { ...data.usage,
    ...(data.usage.prompt_cache_hit_tokens != null ? {
      prompt_tokens_details: { ...data.usage.prompt_tokens_details, cached_tokens: data.usage.prompt_cache_hit_tokens }
    } : {})
  } : null;
  return { message, usage, raw: data };
}

export default { chat };
