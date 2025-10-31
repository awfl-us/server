// Filter: toolCallBackfill
// Purpose:
// 1) Ensure every assistant tool call has a corresponding tool response message.
// 2) Convert orphan tool responses (whose originating assistant tool call is not present)
//    to role: 'system' so OpenAI won't error on missing prior tool_call.
// 3) Normalize ordering so that all tool responses for a given tool_call appear
//    immediately after the assistant message that issued the call, even if
//    interleaved user/assistant messages originally appeared in between.
//    Multiple tool responses per call are preserved in their original order.
//
// Recommended order: run this AFTER any pruning/size filters (e.g., sizeLimiter)
// so it can correctly detect orphans created by earlier filters and then
// normalize ordering on the final window.

function collectAssistantToolCalls(messages = []) {
  // Returns:
  // - byId: Map(tool_call_id -> { assistantIndex })
  // - byAssistantIndex: Map(assistantIndex -> [tool_call_id in order])
  const byId = new Map();
  const byAssistantIndex = new Map();

  messages.forEach((m, idx) => {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) return;
    const ids = [];
    for (const tc of m.tool_calls) {
      if (tc && typeof tc.id === 'string') {
        byId.set(tc.id, { assistantIndex: idx });
        ids.push(tc.id);
      }
    }
    if (ids.length) byAssistantIndex.set(idx, ids);
  });

  return { byId, byAssistantIndex };
}

function collectToolMessages(messages = []) {
  // Returns Map(tool_call_id -> [ { msg, index } ]) preserving encounter order
  const toolsById = new Map();
  messages.forEach((m, idx) => {
    if (m && m.role === 'tool' && typeof m.tool_call_id === 'string') {
      const id = m.tool_call_id;
      let arr = toolsById.get(id);
      if (!arr) {
        arr = [];
        toolsById.set(id, arr);
      }
      arr.push({ msg: m, index: idx });
    }
  });
  return toolsById;
}

export function toolCallBackfill(messages, opts = {}) {
  const {
    missingContent = 'Tool call failed to respond',
    role = 'tool',
    orphanRole = 'system',
    stripOrphanToolId = true,
  } = opts;

  if (!Array.isArray(messages) || messages.length === 0) return messages || [];

  // Index assistant tool_calls and tool messages by id
  const { byId: callIndex, byAssistantIndex } = collectAssistantToolCalls(messages);
  const toolMsgsById = collectToolMessages(messages);

  // Helper: determine orphan status for a tool message within this window
  function isOrphanToolMessage(m) {
    return (
      m &&
      m.role === 'tool' &&
      typeof m.tool_call_id === 'string' &&
      !callIndex.has(m.tool_call_id)
    );
  }

  const output = [];
  const consumedToolMsgIdx = new Set();

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];

    // Handle tool messages first: either convert or skip (to be re-inserted later)
    if (m && m.role === 'tool' && typeof m.tool_call_id === 'string') {
      if (isOrphanToolMessage(m)) {
        // Convert orphan tool messages to the configured role (default: system)
        const copy = { ...m, role: orphanRole };
        if (stripOrphanToolId) {
          const { tool_call_id, ...rest } = copy;
          output.push(rest);
        } else {
          output.push(copy);
        }
      } else {
        // Matched tool message will be re-inserted after its assistant; skip here
        consumedToolMsgIdx.add(i);
      }
      continue;
    }

    // Pass-through any non-tool message
    output.push(m);

    // If assistant with tool_calls: insert all matching tool responses immediately after
    if (m && m.role === 'assistant' && byAssistantIndex.has(i)) {
      const idsInOrder = byAssistantIndex.get(i);
      for (const id of idsInOrder) {
        const arr = toolMsgsById.get(id);
        if (Array.isArray(arr) && arr.length > 0) {
          // Preserve original relative order of multiple tool responses for this id
          arr.sort((a, b) => a.index - b.index);
          for (const { msg, index } of arr) {
            // Only insert if it wasn't already inserted (defensive)
            if (!consumedToolMsgIdx.has(index)) consumedToolMsgIdx.add(index);
            output.push(msg);
          }
        } else {
          // Backfill a synthetic reply if none present in the window
          output.push({
            role,
            tool_call_id: id,
            content: missingContent,
          });
        }
      }
    }
  }

  return output;
}

export default toolCallBackfill;
