// The provider terminal event contains the complete Response, including tools
// and usage. No second tool-argument accumulator or timer is needed.
const terminal = new Map([
  ['response.completed', 'completed'],
  ['response.failed', 'failed'],
  ['response.incomplete', 'incomplete'],
]);

export async function readResponsesStream(events, onDelta) {
  let sink = onDelta;
  const disableSink = () => {
    sink = null;
    console.warn('[llm] response delta sink disabled');
  };
  for await (const event of events) {
    if (terminal.has(event.type)) {
      if (!event.response || event.response.status !== terminal.get(event.type))
        throw new Error('Invalid Responses terminal event');
      return event.response;
    }
    if (event.type === 'error') throw new Error('Responses stream reported a provider error');
    if (event.type !== 'response.output_text.delta' || !sink ||
        typeof event.delta !== 'string' || event.delta.length === 0) continue;
    try {
      // The sink must enqueue synchronously, not await network I/O. Never
      // accumulate unresolved sink promises or block model consumption.
      const accepted = sink({ content: event.delta, outputIndex: event.output_index,
        contentIndex: event.content_index, sequence: event.sequence_number });
      if (accepted && typeof accepted.then === 'function') {
        Promise.resolve(accepted).catch(() => {});
        disableSink();
      }
    } catch {
      disableSink();
    }
  }
  throw new Error('Responses stream ended before a terminal event');
}
