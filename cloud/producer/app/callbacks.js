import axios from 'axios';
import { getWorkflowsIdTokenHeaders } from './auth.js';
import { WORKFLOWS_BASE_URL } from './config.js';
import { contextHeaders } from './config.js';

export async function postCallback(callbackId, payload) {
  const url = `${WORKFLOWS_BASE_URL.replace(/\/$/, '')}/callbacks/${encodeURIComponent(callbackId)}`;
  const authz = await getWorkflowsIdTokenHeaders();
  const headers = {
    'Content-Type': 'application/json',
    ...contextHeaders(),
    ...authz,
  };

  const maxAttempts = 3;
  let attempt = 0;
  let useWrapper = false; // on 400, retry with { result: payload }
  while (attempt < maxAttempts) {
    attempt++;
    try {
      const body = useWrapper ? { result: payload } : payload;
      // Treat <500 as handled (we will inspect status ourselves)
      const resp = await axios.post(url, body, { headers, timeout: 20000, validateStatus: s => s < 500 });
      if (resp.status >= 200 && resp.status < 300) return; // success

      if (resp.status === 400 && !useWrapper) {
        console.warn('[producer] callback 400; retrying with wrapper { result: ... }');
        useWrapper = true;
        continue; // immediate retry without counting as failure/backoff
      }

      // For 404, do not retry (callback expired/not found)
      if (resp.status === 404) {
        const e = new Error('callback_http_404');
        e.status = 404;
        e.noRetry = true;
        throw e;
      }

      // Other 4xx (e.g., 401/403/409) — propagate as error to allow caller policy
      const e = new Error(`callback_http_${resp.status}`);
      e.status = resp.status;
      throw e;
    } catch (err) {
      const status = err?.status ?? err?.response?.status;

      // If server indicated 400 and we haven't wrapped yet, retry with wrapper
      if (status === 400 && !useWrapper) {
        console.warn('[producer] callback 400; retrying with wrapper { result: ... }');
        useWrapper = true;
        continue;
      }

      // Do not retry on 404 (expired callback)
      if (status === 404) {
        err.noRetry = true;
        throw err;
      }

      // Backoff for other transient errors (e.g., 408, 429)
      const backoff = 300 * attempt + Math.floor(Math.random() * 200);
      await new Promise((r) => setTimeout(r, backoff));
      if (attempt >= maxAttempts) throw err;
    }
  }
}
