import { fileContentsLimiter } from './fileContentsLimiter.js';

function tc(functionName, argsObj) {
  return {
    id: `tc-${Math.random().toString(36).slice(2, 8)}`,
    type: 'function',
    function: { name: functionName, arguments: JSON.stringify(argsObj) },
  };
}

function toolMsg(tool_call_id, obj) {
  return {
    role: 'tool',
    tool_call_id,
    content: JSON.stringify(obj),
  };
}

function assistantWithCalls(calls) {
  return {
    role: 'assistant',
    tool_calls: calls,
    content: null,
  };
}

// Build a timeline of messages (older -> newer)
const messages = [
  // Older foo.txt read (should be redacted; too old after we keep last 2)
  toolMsg('call-1', { filepath: 'foo.txt', contents: 'AAA_old_read' }),

  // Older foo.txt update request with contents (should be redacted)
  assistantWithCalls([ tc('update_file', { filepath: 'foo.txt', contents: 'BBB_older_write' }) ]),

  // Newer foo.txt read (should be kept)
  toolMsg('call-3', { filepath: 'foo.txt', contents: 'CCC_new_read' }),

  // Newest foo.txt update request (should be kept)
  assistantWithCalls([ tc('update_file', { filepath: 'foo.txt', contents: 'DDD_newest_write' }) ]),

  // bar.txt older read (kept; bar has only 2 occurrences)
  toolMsg('call-5', { filepath: 'bar.txt', contents: 'EEE_bar_old_read' }),

  // bar.txt latest update (kept)
  assistantWithCalls([ tc('update_file', { filepath: 'bar.txt', contents: 'FFF_bar_latest_write' }) ]),
];

function summarize(msg) {
  if (msg.role === 'tool') {
    try {
      const obj = JSON.parse(msg.content || '{}');
      return { role: 'tool', tool_call_id: msg.tool_call_id, filepath: obj.filepath, contents: obj.contents };
    } catch {
      return { role: 'tool', tool_call_id: msg.tool_call_id, raw: msg.content };
    }
  }
  if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
    const calls = msg.tool_calls.map(tc => {
      try {
        const args = JSON.parse(tc.function?.arguments || '{}');
        return { name: tc.function?.name, filepath: args.filepath, contents: args.contents };
      } catch {
        return { name: tc.function?.name, raw: tc.function?.arguments };
      }
    });
    return { role: 'assistant', tool_calls: calls };
  }
  return { role: msg.role, content: msg.content };
}

console.log('Before:\n', JSON.stringify(messages.map(summarize), null, 2));

const out = fileContentsLimiter(messages, {
  filesLimit: 7,
  versionsPerFile: 2,
  placeholder: '(file contents ommited for space)'
});

console.log('\nAfter:\n', JSON.stringify(out.map(summarize), null, 2));
