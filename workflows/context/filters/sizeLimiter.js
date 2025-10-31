// Simple, composable size-limiter filter for chat messages
// Drops older (earlier) messages first to fit within a token budget.
// Also truncates overly large message contents to a max character length to prevent outliers.
// Notes:
// - Token counting is approximate (chars/4) unless a custom tokenizer is provided.
// - Counts tokens from the entire message object (role, content, tool fields, etc.), not just content.
// - Prioritization: can prefer keeping newer system and/or user messages before others.
// - Always tries to preserve the most recent system message when configured; if over budget,
//   trims older system messages first.

function defaultTokenEstimator(text) {
  if (!text) return 0;
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  // Approximate OpenAI-ish tokenization: ~4 chars/token
  return Math.ceil(s.length / 4);
}

function countMessageTokens(msg, { tokenizer = defaultTokenEstimator, perMessageOverhead = 8 } = {}) {
  // Count tokens based on the whole message (JSON representation), not just content
  const baseTokens = tokenizer(msg ?? "");
  // Small overhead for role/formatting
  return baseTokens + perMessageOverhead;
}

export function sizeLimiter(messages, opts = {}) {
  const {
    maxTokens = 17000,
    tokenizer = defaultTokenEstimator,
    perMessageOverhead = 8,
    // If true, we try to keep system messages over others, trimming oldest systems only if necessary
    prioritizeSystem = false,
    // If true, we try to keep user messages over others (besides any system prioritization)
    prioritizeUser = true,
    // Ensure at least one system message remains if any exist
    preserveAtLeastOneSystem = true,
    // Truncate very large message contents before counting tokens/selection
    maxContentChars = 50000,
  } = opts;

  if (!Array.isArray(messages) || messages.length === 0) return messages || [];

  // Pre-truncate overly large message contents to stabilize token estimates and cap payload size
  const truncatedMessages = messages.map((m) => {
    try {
      if (!m || typeof m !== 'object') return m;
      const c = m.content;
      if (typeof c === 'string' && typeof maxContentChars === 'number' && maxContentChars > 0 && c.length > maxContentChars) {
        return { ...m, content: c.slice(0, maxContentChars) };
      }
      return m;
    } catch (_) {
      return m;
    }
  });

  const tokenOpts = { tokenizer, perMessageOverhead };

  const indices = truncatedMessages.map((_, i) => i);
  const systemIdx = indices.filter(i => truncatedMessages[i]?.role === 'system');
  const userIdx = indices.filter(i => truncatedMessages[i]?.role === 'user');
  const assistantIdx = indices.filter(i => truncatedMessages[i]?.role === 'assistant');
  const toolIdx = indices.filter(i => truncatedMessages[i]?.role === 'tool');

  let tokensUsed = 0;
  const selected = new Set();

  function greedilySelectFromEnd(idxList) {
    for (let k = idxList.length - 1; k >= 0; k--) {
      const i = idxList[k];
      const t = countMessageTokens(truncatedMessages[i], tokenOpts);
      if (tokensUsed + t <= maxTokens) {
        if (!selected.has(i)) {
          selected.add(i);
          tokensUsed += t;
        }
      }
    }
  }

  // Selection order
  if (prioritizeSystem && prioritizeUser) {
    // System first, then User, then the rest (Assistant, Tool) newest-first
    greedilySelectFromEnd(systemIdx);
    greedilySelectFromEnd(userIdx);
    // Merge remaining roles in overall recency
    const others = indices.filter(i => truncatedMessages[i]?.role !== 'system' && truncatedMessages[i]?.role !== 'user');
    greedilySelectFromEnd(others);
  } else if (prioritizeSystem && !prioritizeUser) {
    // System first, then all non-system newest-first (back-compat for prioritizeSystem-only)
    greedilySelectFromEnd(systemIdx);
    const nonSystemIdx = indices.filter(i => truncatedMessages[i]?.role !== 'system');
    greedilySelectFromEnd(nonSystemIdx);
  } else if (!prioritizeSystem && prioritizeUser) {
    // User first, then everyone else newest-first
    greedilySelectFromEnd(userIdx);
    const nonUserIdx = indices.filter(i => truncatedMessages[i]?.role !== 'user');
    greedilySelectFromEnd(nonUserIdx);
  } else {
    // Treat all uniformly: take newest overall
    greedilySelectFromEnd(indices);
  }

  // If nothing selected (budget too small), try to keep the newest system message
  if (selected.size === 0 && preserveAtLeastOneSystem && systemIdx.length > 0) {
    const newestSystem = systemIdx[systemIdx.length - 1];
    selected.add(newestSystem);
  }

  const selectedSorted = Array.from(selected).sort((a, b) => a - b);
  return selectedSorted.map(i => truncatedMessages[i]);
}

export default sizeLimiter;
