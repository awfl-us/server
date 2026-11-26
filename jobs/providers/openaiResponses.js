// Pure transport conversion; not wired to the live adapter until the migration gate passes.
// AWFL history is authoritative; reasoning-item replay for reasoning-enabled tool loops is a later compatibility gate.
export function toResponsesInput(messages) {
  if (!Array.isArray(messages)) throw new TypeError('Responses history must be an array');
  const input = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') throw new TypeError('Invalid Responses history message');
    const { role, content, tool_calls, tool_call_id } = message;
    if (role === 'tool') {
      if (typeof tool_call_id !== 'string' || !tool_call_id || typeof content !== 'string')
        throw new TypeError('Invalid function call output in Responses history');
      input.push({ type: 'function_call_output', call_id: tool_call_id, output: content });
      continue;
    }
    if (!['system', 'developer', 'user', 'assistant'].includes(role))
      throw new TypeError('Unsupported Responses history role');
    if (content != null && typeof content !== 'string')
      throw new TypeError('Unsupported non-text Responses history content');
    if (tool_calls != null && (!Array.isArray(tool_calls) || (role !== 'assistant' && tool_calls.length)))
      throw new TypeError('Invalid tool calls in Responses history');
    if (content != null && (content !== '' || !tool_calls?.length))
      input.push({ role, content });
    else if (role !== 'assistant' || !tool_calls?.length)
      throw new TypeError('Missing Responses history content');
    for (const call of tool_calls || []) {
      if (call?.type !== 'function' || typeof call.id !== 'string' || !call.id ||
          typeof call.function?.name !== 'string' || !call.function.name ||
          typeof call.function?.arguments !== 'string')
        throw new TypeError('Invalid function call in Responses history');
      input.push({ type: 'function_call', call_id: call.id, name: call.function.name,
        arguments: call.function.arguments });
    }
  }
  return input;
}

export function toResponsesTools(tools) {
  if (tools == null) return undefined;
  if (!Array.isArray(tools)) throw new TypeError('Invalid Responses tools');
  return tools.map(tool => {
    const fn = tool?.function;
    if (tool?.type !== 'function' || !fn || typeof fn.name !== 'string' || !fn.name)
      throw new TypeError('Unsupported Responses tool definition');
    return { type: 'function', name: fn.name, description: fn.description,
      parameters: fn.parameters, strict: fn.strict ?? false };
  });
}

export function toResponsesToolChoice(choice) {
  if (choice == null) return undefined;
  if (['auto', 'none', 'required'].includes(choice)) return choice;
  if (choice?.type === 'function' && typeof choice.function?.name === 'string' && choice.function.name)
    return { type: 'function', name: choice.function.name };
  throw new TypeError('Unsupported Responses tool choice');
}

export function toResponsesFormat(format) {
  if (format == null) return undefined;
  if (format.type === 'text' || format.type === 'json_object') return { type: format.type };
  if (format.type === 'json_schema' && format.json_schema?.name && format.json_schema.schema)
    return { type: 'json_schema', ...format.json_schema };
  throw new TypeError('Unsupported Responses text format');
}

export function buildResponsesPayload(params, { reasoningEffort, temperature } = {}) {
  const tools = toResponsesTools(params.tools);
  const format = toResponsesFormat(params.response_format);
  const payload = { model: params.model, input: toResponsesInput(params.messages), store: false };
  if (typeof params.max_tokens === 'number') payload.max_output_tokens = params.max_tokens;
  if (tools?.length) payload.tools = tools;
  if (params.tool_choice != null && tools?.length) payload.tool_choice = toResponsesToolChoice(params.tool_choice);
  if (format) payload.text = { format };
  if (reasoningEffort !== undefined) payload.reasoning = { effort: reasoningEffort };
  if (temperature !== undefined) payload.temperature = temperature;
  return payload;
}

export function normalizeResponsesUsage(usage) {
  if (!usage) return null;
  const result = { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens };
  if (usage.input_tokens_details?.cached_tokens != null)
    result.prompt_tokens_details = { cached_tokens: usage.input_tokens_details.cached_tokens };
  if (usage.output_tokens_details?.reasoning_tokens != null)
    result.completion_tokens_details = { reasoning_tokens: usage.output_tokens_details.reasoning_tokens };
  return result;
}

export function normalizeResponsesResult(response) {
  const usage = normalizeResponsesUsage(response?.usage);
  const fail = code => ({ message: null, usage, failure: code });
  if (response?.status !== 'completed') return fail('response_not_completed');
  if (!Array.isArray(response.output)) return fail('invalid_response_output');
  const text = [], tool_calls = [], seen = new Set();
  for (const item of response.output) {
    if (item?.type === 'reasoning') continue;
    if (item?.type === 'message') {
      if (item.role !== 'assistant' || (item.status != null && item.status !== 'completed') ||
          !Array.isArray(item.content)) return fail('invalid_response_message');
      for (const part of item.content) {
        if (part?.type === 'refusal') return fail('response_refused');
        if (part?.type !== 'output_text' || typeof part.text !== 'string')
          return fail('unsupported_response_content');
        text.push(part.text);
      }
    } else if (item?.type === 'function_call') {
      if ((item.status != null && item.status !== 'completed') ||
          typeof item.call_id !== 'string' || !item.call_id || seen.has(item.call_id) ||
          typeof item.name !== 'string' || !item.name || typeof item.arguments !== 'string')
        return fail('invalid_response_function_call');
      seen.add(item.call_id);
      tool_calls.push({ id: item.call_id, type: 'function',
        function: { name: item.name, arguments: item.arguments } });
    } else {
      return fail('unsupported_response_output');
    }
  }
  const content = text.join('');
  if (!content && !tool_calls.length) return fail('empty_response_output');
  const message = { role: 'assistant', content: content || null };
  if (tool_calls.length) message.tool_calls = tool_calls;
  return { message, usage };
}
