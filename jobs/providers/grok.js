import axios from 'axios';

// xAI Grok - OpenAI-compatible chat completions
// Endpoint base: https://api.x.ai/v1/chat/completions
// Input: { apiKey, model, messages, temperature, max_tokens, response_format, tools, tool_choice }
// Returns: { message, usage, raw }
export async function chat(params) {
  const { apiKey, model, messages, temperature, max_tokens, response_format, tools, tool_choice } = params;
  const body = {
    model,
    messages,
    temperature,
    max_tokens,
    response_format,
    tools,
    tool_choice
  };

  const resp = await axios.post('https://api.x.ai/v1/chat/completions', body, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    timeout: 60_000
  });

  const data = resp.data;
  const choice = data.choices?.[0];
  const message = choice?.message || null;
  const usage = data.usage || null;
  return { message, usage, raw: data };
}

export default { chat };
