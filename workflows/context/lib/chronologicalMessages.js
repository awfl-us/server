// Source document creation times are needed to interleave persisted summaries,
// topic records and chat messages. Do not expose internal timestamps to model
// requests: schema and persisted conversation messages stay unchanged.
const CONTEXT_CREATE_TIME = Symbol.for('awfl.context.createTime');

export function timestampContextMessage(message, createTime) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
  // create_time in the document wrapper is a Unix timestamp in seconds.
  // Ignore absent/malformed timestamps rather than inventing an ordering.
  const value = typeof createTime === 'number' ? createTime :
    typeof createTime === 'string' && createTime.trim() ? Number(createTime) : NaN;
  if (Number.isFinite(value)) {
    Object.defineProperty(message, CONTEXT_CREATE_TIME, { value, enumerable: false });
  }
  return message;
}

export function interleaveContextMessages(messages) {
  // Some callers include literal components without backing documents. Leave
  // their positions untouched; only merge documents with known timestamps.
  const timed = messages.map((message, index) => ({
    message, index, createTime: message?.[CONTEXT_CREATE_TIME],
  })).filter(entry => typeof entry.createTime === 'number')
    .sort((a, b) => a.createTime - b.createTime || a.index - b.index);
  let cursor = 0;
  return messages.map(message => typeof message?.[CONTEXT_CREATE_TIME] === 'number'
    ? timed[cursor++].message : message);
}
