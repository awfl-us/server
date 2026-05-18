// Utility to recursively strip null/undefined fields from JSON-like values
// - Objects: drop keys whose value is null/undefined after recursion
// - Arrays: drop elements that are null/undefined after recursion; keep order
// - Primitives (string/number/boolean): returned as-is
// Notes:
// - Empty strings ("") and 0/false are preserved
// - Dates/RegExp/Functions are not expected; passed through as-is
export function stripNullsDeep(value) {
  if (value === null || value === undefined) return undefined;

  if (Array.isArray(value)) {
    const arr = [];
    for (const el of value) {
      const v = stripNullsDeep(el);
      if (v !== undefined) arr.push(v);
    }
    return arr;
  }

  if (typeof value === 'object') {
    const obj = {};
    for (const [k, v0] of Object.entries(value)) {
      const v = stripNullsDeep(v0);
      if (v !== undefined) obj[k] = v;
    }
    return obj;
  }

  return value;
}

export default { stripNullsDeep };
