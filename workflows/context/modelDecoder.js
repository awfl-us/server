// Decoder for structured context model requests
// Allows callers to specify which Yoj/Ista components to include and any intro/framing messages
// so that composite contexts (like Scala's TopicContext) can be replicated without overloading a
// single 'name'.

// Schema (request.body):
// {
//   kala: Kala, // required
//   model?: {
//     intro?: { system?: string },
//     promoteUpstream?: boolean, // optional; if true, also include promoted Kala context
//     components: Array<{
//       kind: 'yoj' | 'ista' | 'literal',
//       name?: string,         // name of the Yoj/Ista to read when kind is 'yoj' or 'ista'
//       framing?: string,      // optional prefix added to the content for each record
//       value?: string,        // for kind === 'literal', a raw message body
//       children?: Array<...>  // NEW: optional nested components (grouping only)
//     }>,
//     // Optional filter pipeline to post-process the final message list
//     // Each entry can be either a string (filter name) or an object { name, options }
//     filters?: Array<string | { name: string, options?: Record<string, any> }>
//   },
//   presetId?: string // optional convenience, e.g. 'TopicContext'
// }

export function validateKala(kala) {
  if (!kala || typeof kala !== 'object' || !kala.kind) {
    throw new Error('Missing required field: kala.kind');
  }
}

const defaultFilters = [
  { name: 'dropToolCallsCompleted' },
  { name: 'collapseGroupReplacer' },
  { name: 'fileContentsLimiter', options: { filesLimit: 7, versionsPerFile: 2 } },
  { name: 'sizeLimiter' },
  { name: 'toolCallBackfill' }
];

function defaultPreset(presetId) {
  switch (presetId) {
    case 'TopicContext':
      return {
        intro: { system: 'These are the previously extracted topic information, as well as the conversation context: \r' },
        promoteUpstream: true,
        components: [
          { kind: 'yoj', name: 'topicInfos', framing: 'Previously extracted topic info:\r' },
          { kind: 'yoj', name: 'summaries', framing: 'Previous convo summaries:\r' },
          { kind: 'yoj', name: 'messages', framing: 'Summary of older conversation messages:\r' }
        ],
        filters: defaultFilters
      };
    default:
      return null;
  }
}

function normalizeFilters(filters) {
  if (!Array.isArray(filters)) throw new Error(`model.filters must be an array, got ${typeof filters}`);
  return filters.map((f, idx) => {
    if (typeof f === 'string') return { name: f };
    if (f && typeof f === 'object' && typeof f.name === 'string') {
      return { name: f.name, options: (f.options && typeof f.options === 'object') ? f.options : undefined };
    }
    throw new Error(`model.filters[${idx}] must be a string or an object { name, options? }`);
  });
}

// Validation limits for nested components
const MAX_NESTING_DEPTH = 6; // inclusive
const MAX_TOTAL_COMPONENTS = 128; // total nodes, including non-leaf grouping nodes

function normalizeComponent(c, path, depth, counter) {
  const here = `model.components${path.length ? '[' + path.join('][') + ']' : ''}`;
  if (!c || typeof c !== 'object') {
    throw new Error(`${here} must be an object`);
  }
  if (depth > MAX_NESTING_DEPTH) {
    throw new Error(`Maximum nesting depth exceeded at ${here}: depth must be <= ${MAX_NESTING_DEPTH}`);
  }
  counter.count += 1;
  if (counter.count > MAX_TOTAL_COMPONENTS) {
    throw new Error(`Too many components: maximum total (including nested/grouping nodes) is ${MAX_TOTAL_COMPONENTS}`);
  }

  const kind = c.kind;
  if (!kind) throw new Error(`${here}.kind is required`);

  const hasChildrenArray = Array.isArray(c.children) && c.children.length > 0;
  let children;
  if (Array.isArray(c.children)) {
    children = c.children.map((child, idx) => normalizeComponent(child, [...path, 'children', String(idx)], depth + 1, counter));
    if (!children.length) children = undefined;
  }

  if (kind === 'yoj' || kind === 'ista') {
    if (!c.name || typeof c.name !== 'string') {
      throw new Error(`${here}.name is required for kind='${kind}'`);
    }
    const framing = typeof c.framing === 'string' ? c.framing : '';
    return children ? { kind, name: c.name, framing, children } : { kind, name: c.name, framing };
  } else if (kind === 'literal') {
    if (typeof c.value !== 'string') {
      throw new Error(`${here}.value must be a string for kind='literal'`);
    }
    if (hasChildrenArray) {
      // Reject literal-with-children to avoid ambiguity
      throw new Error(`${here}: literal components cannot have children`);
    }
    return { kind, value: c.value };
  }
  throw new Error(`Unsupported component kind: ${kind}`);
}

export function decodeContextModel(body) {
  const { kala, model, presetId } = body || {};
  validateKala(kala);

  let normalized = null;
  if (model && typeof model === 'object') {
    const components = Array.isArray(model.components) ? model.components : [];
    const counter = { count: 0 };
    console.log("Filters: ", model.filters ?? defaultFilters);
    normalized = {
      intro: model.intro && typeof model.intro === 'object' ? model.intro : undefined,
      promoteUpstream: Boolean(model.promoteUpstream),
      components: components.map((c, idx) => normalizeComponent(c, [String(idx)], 1, counter)),
      filters: normalizeFilters(model.filters ?? defaultFilters)
    };
  } else if (typeof presetId === 'string') {
    const preset = defaultPreset(presetId);
    if (!preset) throw new Error(`Unknown presetId: ${presetId}`);
    normalized = preset;
  } else {
    // Fallback: empty model with default filters
    normalized = {
      intro: undefined,
      promoteUpstream: false,
      components: [],
      filters: [
        { name: 'sizeLimiter', options: { maxTokens: 24000 } },
        { name: 'toolCallBackfill' }
      ]
    };
  }

  console.log("Model: ",  JSON.stringify(normalized, null, 2));

  return { kala, model: normalized };
}
