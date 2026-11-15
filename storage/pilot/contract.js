// Provider-neutral, *single-record* concurrency contract used by the initial
// AWFL execution-state benchmark. Full Storage remains specified in docs.
export class RecordConflictError extends Error {
  constructor(message = 'record conflict') {
    super(message);
    this.name = 'RecordConflictError';
    this.code = 'CONFLICT';
  }
}
export class RecordExistsError extends RecordConflictError {
  constructor() { super('record already exists'); this.code = 'ALREADY_EXISTS'; }
}
export class RecordMissingError extends Error {
  constructor() { super('record not found'); this.code = 'NOT_FOUND'; }
}
export const copy = value => value == null ? value : structuredClone(value);
export function checkKey(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(key)) {
    throw new TypeError('invalid atomic record identifier');
  }
  return key;
}
// A backend must provide get, create-only, atomic mutate, put, and delete.
// mutate's pure synchronous change function may be invoked more than once.
// Returning undefined aborts with CONFLICT. Implementations must never use
// an unguarded read + set sequence in the mutate path.
export function assertAtomicRecordStore(store) {
  for (const operation of ['get', 'create', 'mutate', 'put', 'delete']) {
    if (typeof store?.[operation] !== 'function') throw new TypeError(`store missing ${operation}`);
  }
  return store;
}
