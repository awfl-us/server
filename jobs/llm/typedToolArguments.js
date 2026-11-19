/**
 * Opt-in typed tool argument validation. Do not modify existing tool flows.
 * Supports precisely the subset emitted by workflow-utils JsonSchema; any
 * unrecognized schema keyword fails closed rather than weakening validation.
 */
const allowed = new Set(['type', 'title', 'properties', 'required', 'items', 'oneOf', 'additionalProperties']);
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateSchema(schema, value, path = '$') {
  if (!plainObject(schema)) throw new TypeError(`Unsupported schema at ${path}: expected object`);
  for (const k of Object.keys(schema)) {
    if (!allowed.has(k)) throw new TypeError(`Unsupported schema keyword ${path}.${k}`);
  }
  if (own(schema, 'oneOf')) {
    if (Object.keys(schema).some(k => k !== 'oneOf' && k !== 'title') ||
        !Array.isArray(schema.oneOf) || schema.oneOf.length === 0) {
      throw new TypeError(`Invalid oneOf schema at ${path}`);
    }
    const matches = schema.oneOf.filter(option => validateSchema(option, value, path).length === 0);
    return matches.length === 1 ? [] : [`${path}: expected exactly one matching variant (got ${matches.length})`];
  }
  const type = schema.type;
  if (!['object','array','string','boolean','integer','number','null'].includes(type)) {
    throw new TypeError(`Unsupported schema type at ${path}: ${String(type)}`);
  }
  const correct = type === 'object' ? plainObject(value) :
    type === 'array' ? Array.isArray(value) :
    type === 'integer' ? Number.isSafeInteger(value) :
    type === 'number' ? typeof value === 'number' && Number.isFinite(value) :
    type === 'null' ? value === null : typeof value === type;
  if (!correct) return [`${path}: expected ${type}`];
  if (type === 'array') {
    if (!own(schema,'items')) throw new TypeError(`Array schema missing items at ${path}`);
    return value.flatMap((item,index) => validateSchema(schema.items,item,`${path}[${index}]`));
  }
  if (type !== 'object') return [];
  if (schema.properties !== undefined && !plainObject(schema.properties)) {
    throw new TypeError(`Invalid properties at ${path}`);
  }
  if (schema.required !== undefined &&
      (!Array.isArray(schema.required) || schema.required.some(x => typeof x !== 'string'))) {
    throw new TypeError(`Invalid required list at ${path}`);
  }
  const props = schema.properties || {};
  const missing = (schema.required || []).filter(field => !own(value,field)).map(field => `${path}.${field}: required`);
  const errors = [...missing];
  for (const [key,entry] of Object.entries(value)) {
    if (own(props,key)) {
      errors.push(...validateSchema(props[key], entry, `${path}.${key}`));
    } else if (schema.additionalProperties === false) {
      errors.push(`${path}.${key}: unexpected property`);
    } else if (plainObject(schema.additionalProperties)) {
      errors.push(...validateSchema(schema.additionalProperties,entry,`${path}.${key}`));
    } else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
      throw new TypeError(`Invalid additionalProperties at ${path}`);
    }
  }
  return errors;
}

/**
 * Returns decoded validated calls or throws with a safe field-path error.
 * Never return or log raw user/tool arguments on failure.
 */
export function parseTypedToolCalls(message, tools) {
  const declared = new Map();
  for (const tool of tools || []) {
    if (tool?.type !== 'function' || typeof tool.function?.name !== 'string' ||
        !plainObject(tool.function.parameters) || declared.has(tool.function.name)) {
      throw new TypeError('Typed tool definitions must have unique function names and object parameters');
    }
    declared.set(tool.function.name,tool.function.parameters);
  }
  if (!Array.isArray(message?.tool_calls)) return [];
  return message.tool_calls.map((call,index) => {
    const name = call?.function?.name;
    if (call?.type !== 'function' || typeof name !== 'string' || !declared.has(name)) {
      throw new TypeError(`Unknown or malformed typed tool call at index ${index}`);
    }
    if (typeof call.function.arguments !== 'string') throw new TypeError(`Missing JSON arguments for ${name}`);
    let args;
    try { args = JSON.parse(call.function.arguments); }
    catch { throw new TypeError(`Malformed JSON arguments for ${name}`); }
    const issues = validateSchema(declared.get(name),args);
    if (issues.length) throw new TypeError(`Invalid arguments for ${name}: ${issues.join('; ')}`);
    return {name, id:call.id, arguments:args};
  });
}
