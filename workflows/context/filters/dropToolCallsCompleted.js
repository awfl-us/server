// dropToolCallsCompleted.js
// Keeps only the latest user message whose content equals the target phrase
// (default: "Tool calls completed"). Earlier user messages with that exact
// content are removed.
//
// Options (all optional):
// - phrase: string (default "Tool calls completed")
// - caseSensitive: boolean (default true)
// - trim: boolean (default true)

export function dropToolCallsCompleted(messages, opts = {}, _ctx = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return Array.isArray(messages) ? messages : [];

  const phrase = typeof opts.phrase === 'string' ? opts.phrase : 'Tool calls completed';
  const caseSensitive = opts.caseSensitive !== false; // default true
  const trim = opts.trim !== false; // default true

  function matches(msg) {
    try {
      if (!msg || typeof msg !== 'object') return false;
      if (msg.role !== 'user') return false;
      const c = msg.content;
      if (typeof c !== 'string') return false;
      const s = trim ? c.trim() : c;
      if (caseSensitive) return s === phrase;
      return s.toLowerCase() === phrase.toLowerCase();
    } catch (_) {
      return false;
    }
  }

  let seenLatest = false;
  const keptOrNull = new Array(messages.length);

  // Walk from newest to oldest to find the latest matching message
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (matches(m)) {
      if (!seenLatest) {
        // Keep the newest matching user message
        keptOrNull[i] = m;
        seenLatest = true;
      } else {
        // Drop older matching user messages
        keptOrNull[i] = null;
      }
    } else {
      keptOrNull[i] = m;
    }
  }

  return keptOrNull.filter(Boolean);
}

export default { dropToolCallsCompleted };
