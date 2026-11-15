import { assertAtomicRecordStore, checkKey, copy, RecordConflictError, RecordExistsError } from '../contract.js';
// Realtime Database REST ETags provide server-side CAS semantics. The standard
// Admin SDK's transaction callback can initially observe null for a populated
// ref; ETag CAS avoids cold-cache ambiguity for execution-ownership fencing.
export class RealtimeAtomicRecords {
  constructor({ databaseURL, tokenProvider, root = 'nativeStorageBenchmark', fetchImpl = fetch, maxRetries = 8 }) {
    if (!databaseURL?.startsWith('https://') || typeof tokenProvider !== 'function') {
      throw new TypeError('RTDB HTTPS URL and OAuth token provider required');
    }
    this.base = databaseURL.replace(/\/$/, '');
    this.root = checkKey(root);
    this.tokenProvider = tokenProvider;
    this.fetch = fetchImpl;
    this.maxRetries = maxRetries;
    assertAtomicRecordStore(this);
  }
  url(key) { return `${this.base}/${this.root}/${checkKey(key)}.json`; }
  async call(key, { method = 'GET', etag = false, ifMatch, value } = {}) {
    const token = await this.tokenProvider();
    if (!token) throw new Error('RTDB OAuth token unavailable');
    const headers = { Authorization: `Bearer ${token}` };
    if (etag) headers['X-Firebase-ETag'] = 'true';
    if (ifMatch !== undefined) headers['if-match'] = ifMatch;
    if (value !== undefined) headers['Content-Type'] = 'application/json';
    const response = await this.fetch(this.url(key), { method, headers,
      ...(value !== undefined && { body: JSON.stringify(value) }) });
    const body = await response.text();
    if (![200, 204, 412].includes(response.status)) {
      throw new Error(`RTDB ${method} HTTP ${response.status}: ${body.slice(0, 150)}`);
    }
    return { status: response.status, value: body ? JSON.parse(body) : null,
      etag: response.headers.get('etag') };
  }
  async get(key) { return copy((await this.call(key)).value); }
  async put(key, value) { await this.call(key, { method: 'PUT', value: copy(value) }); }
  async create(key, value) {
    // null_etag matches only an absent location, atomically on the server.
    const response = await this.call(key, { method: 'PUT', ifMatch: 'null_etag', value: copy(value) });
    if (response.status === 412) throw new RecordExistsError();
  }
  async mutate(key, change) {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const current = await this.call(key, { etag: true });
      if (!current.etag) throw new Error('RTDB ETag response required for conditional update');
      const next = change(copy(current.value));
      if (next === undefined) throw new RecordConflictError();
      const written = await this.call(key, { method: 'PUT', ifMatch: current.etag, value: copy(next) });
      if (written.status !== 412) return copy(next);
    }
    throw new RecordConflictError('RTDB CAS exhausted retries');
  }
  async delete(key) { await this.call(key, { method: 'DELETE' }); }
  async close() {}
}
