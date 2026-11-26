// AWFL persists message metadata alongside conversation content. Those fields
// are not part of OpenAI's Chat Completions message schema, and may change on
// every workflow invocation even when the prompt content has not changed.
//
// Keep this normalization limited to OpenAI's transport boundary: timestamps
// and document identifiers are still needed by AWFL's storage and UI.
export function toOpenAiMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map(message => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return message;
    }
    const { create_time, docId, responseId, ...openAiMessage } = message;
    return openAiMessage;
  });
}
