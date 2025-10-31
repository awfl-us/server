import express from 'express';
import { OpenAI } from 'openai';

const router = express.Router();

// Initialize OpenAI client (expects process.env.OPENAI_API_KEY)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "mock",
});

// Pricing per 1,000,000 tokens in USD for OpenAI models (as of May 2025)
const PRICING = {
  'gpt-3.5-turbo': { prompt: 0.50, completion: 1.50 },
  'gpt-3.5-turbo-16k': { prompt: 3.00, completion: 4.00 },
  'gpt-4': { prompt: 30.00, completion: 60.00 },
  'gpt-4-32k': { prompt: 60.00, completion: 120.00 },
  'gpt-4-turbo': { prompt: 10.00, completion: 30.00 },
  'gpt-4o': { prompt: 2.50, completion: 10.00 },
  'chatgpt-4o-latest': { prompt: 5.00, completion: 10.00 },
  'gpt-4o-mini': { prompt: 0.15, completion: 0.60 },
  'gpt-4.1': { prompt: 2.00, completion: 8.00 },
  'gpt-4.1-mini': { prompt: 0.40, completion: 1.60 },
  'gpt-4.1-nano': { prompt: 0.10, completion: 0.40 },
  'gpt-4.5': { prompt: 75.00, completion: 150.00 },
  'o1': { prompt: 15.00, completion: 60.00 },
  'o3': { prompt: 2.00, completion: 8.00 },
  'gpt-5': { prompt: 1.25, completion: 10.00 } // fixed key: completion
};

// Max token limits for known models
const MAX_TOKENS = {
  'gpt-4o': 16384,
  'chatgpt-4o-latest': 16384,
  'gpt-4-turbo': 4096,
  'gpt-4.1': 32768,
  'gpt-4': 8192,
  'gpt-4-32k': 4096,
  'gpt-3.5-turbo': 4096,
  'gpt-3.5-turbo-16k': 4096,
  'o4-mini': 100000,
  'o3': 100000,
  'gpt-5': 128000
};

function fixed_temperature(model, temperature) {
  const fixed = { 'o3': 1, 'gpt-5': 1 };
  return fixed[model] ?? temperature; // ensure a value is returned
}

function estimateCost(model, usage) {
  const m = PRICING[model] || PRICING['gpt-4'];
  if (!usage) return null;
  return (
    ((usage.prompt_tokens || 0) / 1_000_000) * (m.prompt || 0) +
    ((usage.completion_tokens || 0) / 1_000_000) * (m.completion || 0)
  );
}

function resolveMaxTokens(model, fallback = 16384) {
  return MAX_TOKENS[model] || fallback;
}

router.post('/chat', async (req, res) => {
  try {
    console.log(`Chat request: ${JSON.stringify(req.body, null, 2)}`);
    // Accept both max_completion_tokens (preferred) and legacy max_tokens
    const { messages, model = 'gpt-4', temperature = 0.7, max_tokens, max_completion_tokens, response_format, tools, tool_choice } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Missing or invalid "messages" array in request body.' });
    }

    const resolvedMaxTokens = (max_completion_tokens ?? max_tokens) ?? resolveMaxTokens(model);

    const response = await openai.chat.completions.create({
      model,
      messages,
      temperature: fixed_temperature(model, temperature),
      max_completion_tokens: resolvedMaxTokens,
      response_format,
      tools,
      tool_choice
    });

    console.log('Full LLM response:', JSON.stringify(response, null, 2));

    const choice = response.choices?.[0];
    const message = choice?.message
    // const reply = choice?.message?.content || '';
    // const tool_calls = choice?.message?.tool_calls || [];
    const usage = response.usage;
    const total_cost = estimateCost(model, usage);

    // let result;
    // if (tool_calls && tool_calls.length) {
    //   result = { tool_calls };
    // } else if (response_format?.type === 'json_object') {
    //   try {
    //     result = reply ? JSON.parse(reply) : {};
    //   } catch (e) {
    //     result = {};
    //   }
    // } else {
    //   result = { reply };
    // }

    res.status(200).json({ message, usage, total_cost });
  } catch (error) {
    console.error('LLM chat error:', error);
    res.status(500).json({ error: 'Failed to complete chat request: ' + (error?.message || String(error)) });
  }
});

export default router;
