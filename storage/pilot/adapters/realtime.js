import { assertAtomicRecordStore, checkKey, copy, RecordConflictError, RecordExistsError } from '../contract.js';
// Realtime Database REST ETags provide server-side CAS semantics. The standard
// Admin SDK's transaction callback can initially observe null for a populated
// ref; ETag CAS avoids cold-cache ambiguity for execution-ownership fencing.
export class RealtimeAtomicRecords {
  constructor({ databaseURL, tokenProvider, root = 'nativeStorageBenchmark',
    fetchImpl = fetch, maxRetries = 8, emulator = false, databaseNamespace } = {}) {
    // Explicit opt-in for loopback HTTP emulators; production remains HTTPS-only.
    const parsed = new URL(databaseURL);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (emulator ? (!loopback || parsed.protocol !== 'http:') :
      (parsed.protocol !== 'https:' || typeof tokenProvider !== 'function')) {
      throw new TypeError('RTDB requires HTTPS OAuth, or an explicitly opted-in loopback emulator');
    }
    if (emulator && (!databaseNamespace || !/^[A-Za-z0-9_.-]{1,120}$/.test(databaseNamespace))) {
      throw new TypeError('RTDB emulator namespace required');
    }
    this.base = databaseURL.replace(/\/$/, '');
    this.root = checkKey(root);
    this.tokenProvider = tokenProvider;
    this.emulator = emulator;
    this.databaseNamespace = databaseNamespace;
    this.fetch = fetchImpl;
    this.maxRetries = maxRetries;
    assertAtomicRecordStore(this);
  }
  url(key) {
    const suffix = this.emulator ? `?ns=${encodeURIComponent(this.databaseNamespace)}` : '';
    return `${this.base}/${this.root}/${checkKey(key)}.json${suffix}`;
  }
  async call(key, { method = 'GET', etag = false, ifMatch, value } = {}) {
    const headers = {};
    if (!this.emulator) {
      const token = await this.tokenProvider();
      if (!token) throw new Error('RTDB OAuth token unavailable');
      headers.Authorization = `Bearer ${token}`;
    }
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
