import axios from 'axios';
import { getWorkflowsIdTokenHeaders } from './auth.js';
import { contextHeaders, SHUTDOWN_TIMEOUT_MS, WORKFLOWS_BASE_URL, X_PROJECT_ID, CONSUMER_ID } from './config.js';

// Release project lock on shutdown
export async function releaseProjectLock(reason = 'shutdown') {
  try {
    const base = WORKFLOWS_BASE_URL.replace(/\/$/, '');
    const url = `${base}/projects/${encodeURIComponent(X_PROJECT_ID)}/consumer-lock/release`;
    const authz = await getWorkflowsIdTokenHeaders();
    const headers = { 'Content-Type': 'application/json', ...contextHeaders(), ...authz };

    // Include consumerId so the release endpoint can validate ownership
    const body = { reason, at: Date.now(), ...(CONSUMER_ID ? { consumerId: CONSUMER_ID } : {}) };
    const maxAttempts = 3;
    let attempt = 0;
    while (attempt < maxAttempts) {
      attempt++;
      try {
        const resp = await axios.post(url, body, { headers, timeout: 2500, validateStatus: (s) => s < 500 });
        if (resp.status >= 200 && resp.status < 300) {
          console.log('[producer] released project lock', { projectId: X_PROJECT_ID, consumerId: CONSUMER_ID || null });
          return true;
        }
        console.warn('[producer] lock release non-2xx', { status: resp.status });
      } catch (err) {
        console.warn('[producer] lock release attempt failed', err?.message || err);
      }
      const backoff = 150 * attempt + Math.floor(Math.random() * 100);
      await new Promise((r) => setTimeout(r, backoff));
    }
  } catch (err) {
    console.warn('[producer] lock release error', err?.message || err);
  }
  return false;
}

let shuttingDown = false;
export async function gracefulShutdown(code = 0, signal = 'signal') {
  if (shuttingDown) return; // idempotent
  shuttingDown = true;
  try {
    console.log('[producer] shutting down', { code, signal });
    await Promise.race([
      releaseProjectLock(`process_${signal}`),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
    ]);
  } catch (_) {
    // ignore
  } finally {
    // ensure exit code semantics preserved
    try { process.exit(code); } catch {}
  }
}

// Attach shutdown hooks early so even early exits try to release
process.on('SIGINT', () => { gracefulShutdown(0, 'SIGINT'); });
process.on('SIGTERM', () => { gracefulShutdown(0, 'SIGTERM'); });
process.on('SIGHUP', () => { gracefulShutdown(0, 'SIGHUP'); });
process.on('beforeExit', (code) => { gracefulShutdown(code, 'beforeExit'); });
process.on('uncaughtException', (err) => { console.error('[producer] uncaughtException', err); gracefulShutdown(1, 'uncaughtException'); });
process.on('unhandledRejection', (reason) => { console.error('[producer] unhandledRejection', reason); gracefulShutdown(1, 'unhandledRejection'); });
