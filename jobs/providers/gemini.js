import axios from 'axios';

// Google Gemini (Generative Language) REST adapter
// Endpoint: POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key=API_KEY
// Input: { apiKey, model, messages, temperature, max_tokens }
// Returns: { message, usage, raw }
export async function chat(params) {
  const { apiKey, model, messages = [], temperature = 0.7, max_tokens = 1024 } = params;

  // Aggregate system instructions
  const systemText = messages
    .filter(m => m.role === 'system' && m.content)
    .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n\n');

  // Map to Gemini contents. Roles: 'user' or 'model'
  const contents = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
    }));

  const body = {
    contents,
    generationConfig: {
      temperature,
      maxOutputTokens: max_tokens
    },
    ...(systemText ? { systemInstruction: { role: 'system', parts: [{ text: systemText }] } } : {})
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const resp = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 60_000
  });

  const data = resp.data;
  let text = '';
  const first = data?.candidates?.[0];
  if (first?.content?.parts) {
    for (const p of first.content.parts) {
      if (typeof p.text === 'string') text += p.text;
    }
  }
  const message = { role: 'assistant', content: text };

  const u = data?.usageMetadata;
  const usage = u ? {
    prompt_tokens: u.promptTokenCount,
    completion_tokens: u.candidatesTokenCount,
    total_tokens: u.totalTokenCount
  } : null;

  return { message, usage, raw: data };
}

export default { chat };
