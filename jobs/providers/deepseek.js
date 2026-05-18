import axios from 'axios';

// DeepSeek - largely OpenAI-compatible chat completions API
// Endpoint base: https://api.deepseek.com/v1
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
  const usage = data.usage || null;
  return { message, usage, raw: data };
}

export default { chat };
