// fileContentsLimiter.js
// Redacts large file contents in tool call messages, keeping only the most recent
// N files and the last M versions per file. Older occurrences have their `content`
// replaced with a placeholder to save context budget.
//
// Default behavior (configurable via options):
// - Keep full contents for up to 7 most recent distinct files
// - For each file, keep full contents for up to 2 most recent versions
// - For all other matches, replace `content` with the placeholder
//
// Targets:
// - tool messages (role: 'tool') whose JSON content contains { filepath, content }
//   and that have a tool_call_id (to ensure they are tool responses)
// - assistant messages with tool_calls[].function.arguments JSON containing { filepath, content }
//
// Notes:
// - Recency is determined by scanning the window from newest to oldest (array end to start).
// - Only the `content` field is redacted; other metadata (e.g., filepath) is preserved.
// - Placeholder defaults to the user-provided phrase: '(file contents ommited for space)'.

function safeParseJSON(str) {
  if (typeof str !== 'string') return { ok: false };
  try {
    const obj = JSON.parse(str);
    if (obj && typeof obj === 'object') return { ok: true, value: obj };
    return { ok: false };
  } catch (_) {
    return { ok: false };
  }
}

export function fileContentsLimiter(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  const filesLimit = Number.isInteger(options.filesLimit) ? options.filesLimit : 7;
  const versionsPerFile = Number.isInteger(options.versionsPerFile) ? options.versionsPerFile : 2;
  const placeholder = typeof options.placeholder === 'string' ? options.placeholder : '(File contents ommited to save context. You can only see that last seven read/updated file contents.)';
  const detectAssistantToolCalls = options.detectAssistantToolCalls !== false; // default true
  const detectToolMessages = options.detectToolMessages !== false; // default true

  const withinLimitFiles = new Set();
  const beyondLimitFiles = new Set();
  const versionsKept = new Map(); // filepath -> count of kept full-contents versions

  function shouldKeepContents(filepath) {
    if (!filepath || typeof filepath !== 'string') return false;
    if (!withinLimitFiles.has(filepath) && !beyondLimitFiles.has(filepath)) {
      // First time we see this file (from newest to oldest)
      if (withinLimitFiles.size < filesLimit) {
        withinLimitFiles.add(filepath);
      } else {
        beyondLimitFiles.add(filepath);
      }
    }
    if (beyondLimitFiles.has(filepath)) return false;
    const kept = versionsKept.get(filepath) || 0;
    if (kept < versionsPerFile) {
      versionsKept.set(filepath, kept + 1);
      return true;
    }
    return false;
  }

  // Create a shallow copy to avoid mutating the original array reference
  const out = messages.map(m => m);

  // Iterate from newest to oldest
  for (let i = out.length - 1; i >= 0; i--) {
    const msg = out[i];
    if (!msg || typeof msg !== 'object') continue;

    // Case A: tool messages with JSON content containing filepath + content
    if (detectToolMessages && msg.role === 'tool' && msg.tool_call_id && typeof msg.content === 'string') {
      const parsed = safeParseJSON(msg.content);
      if (parsed.ok && parsed.value && typeof parsed.value === 'object') {
        const obj = parsed.value;
        if (Object.prototype.hasOwnProperty.call(obj, 'filepath') && Object.prototype.hasOwnProperty.call(obj, 'content')) {
          const fp = obj.filepath;
          const keep = shouldKeepContents(fp);
          if (!keep) {
            // Redact content
            const clone = { ...msg };
            const newObj = { ...obj, content: placeholder };
            clone.content = JSON.stringify(newObj);
            out[i] = clone;
          }
        }
      }
    }

    // Case B: assistant messages with tool_calls[].function.arguments JSON
    if (detectAssistantToolCalls && msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      let modified = false;
      const newToolCalls = msg.tool_calls.map(tc => {
        if (!tc || !tc.function) return tc;
        const argsStr = tc.function.arguments;
        const parsedArgs = safeParseJSON(argsStr);
        if (!parsedArgs.ok) return tc;
        const args = parsedArgs.value;
        if (args && typeof args === 'object' && Object.prototype.hasOwnProperty.call(args, 'filepath') && Object.prototype.hasOwnProperty.call(args, 'content')) {
          const fp = args.filepath;
          const keep = shouldKeepContents(fp);
          if (!keep) {
            const newArgs = { ...args, content: placeholder };
            const newFn = { ...tc.function, arguments: JSON.stringify(newArgs) };
            modified = true;
            return { ...tc, function: newFn };
          }
        }
        return tc;
      });
      if (modified) {
        out[i] = { ...msg, tool_calls: newToolCalls };
      }
    }
  }

  return out;
}

export default { fileContentsLimiter };
