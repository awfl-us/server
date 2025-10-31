// Filter registry and composition utilities
// Enables composing multiple context filters in a deterministic pipeline.
// Each filter can be sync or async:
//   (messages: ChatMessage[], options?: any, ctx?: any) => ChatMessage[] | Promise<ChatMessage[]>

import { sizeLimiter as sizeLimiterFilter } from './sizeLimiter.js';
import { toolCallBackfill as toolCallBackfillFilter } from './toolCallBackfill.js';
import { fileContentsLimiter as fileContentsLimiterFilter } from './fileContentsLimiter.js';
import { collapseGroupReplacer as collapseGroupReplacerFilter } from './collapseGroupReplacer.js';
import { dropToolCallsCompleted as dropToolCallsCompletedFilter } from './dropToolCallsCompleted.js';

const registry = new Map([
  ['sizeLimiter', sizeLimiterFilter],
  ['toolCallBackfill', toolCallBackfillFilter],
  ['fileContentsLimiter', fileContentsLimiterFilter],
  ['collapseGroupReplacer', collapseGroupReplacerFilter],
  // Keeps only the latest user message whose content equals the phrase (default: "Tool calls completed")
  ['dropToolCallsCompleted', dropToolCallsCompletedFilter],
]);

export async function applyFilters(messages, filtersSpec = [], ctx = {}) {
  if (!Array.isArray(filtersSpec) || filtersSpec.length === 0) return Array.isArray(messages) ? messages : [];

  let acc = Array.isArray(messages) ? messages : [];
  for (let idx = 0; idx < filtersSpec.length; idx++) {
    const spec = filtersSpec[idx];
    try {
      if (!spec) continue;
      const name = typeof spec === 'string' ? spec : spec.name;
      const options = typeof spec === 'object' && spec !== null ? (spec.options || {}) : {};
      const fn = registry.get(name);
      if (!fn) {
        console.warn(`Unknown filter '${name}' at index ${idx}; skipping.`);
        continue;
      }
      const out = await Promise.resolve(fn(acc, options, ctx));
      // Ensure array of messages is returned; if not, fallback to previous acc
      acc = Array.isArray(out) ? out : acc;
    } catch (e) {
      console.error(`Error applying filter at index ${idx}:`, e);
      // Fail open: keep current acc and continue
    }
  }
  return acc;
}

export function registerFilter(name, fn) {
  if (!name || typeof fn !== 'function') return;
  registry.set(name, fn);
}

export default {
  applyFilters,
  registerFilter,
};
