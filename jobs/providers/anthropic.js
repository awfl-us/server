import axios from 'axios';

// Anthropic Claude Messages API adapter
// Input: { apiKey, model, messages, temperature, max_tokens }
// Returns: { message, usage, raw }
export async function chat(params) {
  const { apiKey, model, messages = [], temperature = 0.7, max_tokens = 1024 } = params;

  // Extract system messages
  const systemText = messages
    .filter(m => m.role === 'system' && m.content)
    .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n\n');

  // Convert to Anthropic message format
  const mapped = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({
      role: m.role,
      content: [ { type: 'text', text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) } ]
    }));

  const body = {
    model,
    messages: mapped,
    temperature,
    max_tokens,
    ...(systemText ? { system: systemText } : {})
  };

  const resp = await axios.post('https://api.anthropic.com/v1/messages', body, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    timeout: 60_000
  });

  const data = resp.data;
  // data.content is an array of blocks; concatenate text blocks
  let text = '';
  if (Array.isArray(data?.content)) {
    for (const blk of data.content) {
      if (blk?.type === 'text' && blk?.text) { text += blk.text; }
    }
  }
  const message = { role: 'assistant', content: text };

  const u = data?.usage;
  const usage = u ? {
    prompt_tokens: u.input_tokens,
    completion_tokens: u.output_tokens,
    total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0)
  } : null;

  return { message, usage, raw: data };
}

export default { chat };
