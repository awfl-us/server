import axios from 'axios';
import { getWorkflowsIdTokenHeaders } from './auth.js';
import { contextHeaders, SHUTDOWN_TIMEOUT_MS, WORKFLOWS_BASE_URL, X_PROJECT_ID, CONSUMER_ID } from './config.js';

// Simple shutdown hook registry so subsystems can cleanly teardown before we release the lock
const shutdownHooks = new Set();
let shuttingDown = false;

export function registerShutdownHook(fn) {
  if (typeof fn === 'function') shutdownHooks.add(fn);
  return () => shutdownHooks.delete(fn);
}

async function runShutdownHooks() {
  const perHookTimeout = Math.max(500, Math.floor(SHUTDOWN_TIMEOUT_MS / 2));
  const hooks = Array.from(shutdownHooks);
  if (!hooks.length) return;
  console.log('[producer] running shutdown hooks', { count: hooks.length, timeoutPerHookMs: perHookTimeout });
  await Promise.allSettled(
    hooks.map((fn) =>
      Promise.race([
        Promise.resolve().then(() => fn()).catch((err) => {
          console.warn('[producer] shutdown hook failed', err?.message || err);
        }),
        new Promise((resolve) => setTimeout(resolve, perHookTimeout)),
      ]),
    ),
  );
}

// Unified stop against the same base as the event stream
async function postUnifiedStop(reason = 'shutdown') {
  const base = WORKFLOWS_BASE_URL.replace(/\/$/, '');
  if (!base) return false;
  const url = `${base}/producer/stop`;
  const idTokenHeaders = await getWorkflowsIdTokenHeaders();
  const headers = {
    'Content-Type': 'application/json',
    ...contextHeaders(),
    ...idTokenHeaders,
  };
  const body = { reason, at: Date.now(), ...(CONSUMER_ID ? { consumerId: CONSUMER_ID } : {}) };

  const maxAttempts = 3;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const resp = await axios.post(url, body, { headers, timeout: 2500, validateStatus: (s) => s < 500 });
      if (resp.status >= 200 && resp.status < 300) {
        console.log('[producer] unified stop posted to server');
        return true;
      }
      console.warn('[producer] unified stop non-2xx', { status: resp.status });
    } catch (err) {
      console.warn('[producer] unified stop attempt failed', err?.message || err);
    }
    const backoff = 150 * (i + 1) + Math.floor(Math.random() * 100);
    await new Promise((r) => setTimeout(r, backoff));
  }
  return false;
}

// Release project lock on shutdown (fallback)
export async function releaseProjectLock(reason = 'shutdown') {
  try {
    const base = WORKFLOWS_BASE_URL.replace(/\/$/, '');
    if (!base) return false;
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

export async function gracefulShutdown(code = 0, signal = 'signal') {
  if (shuttingDown) return; // idempotent
  shuttingDown = true;
  try {
    console.log('[producer] shutting down', { code, signal });

    // 1) Give subsystems a chance to cleanup and stop reconnects, etc.
    await Promise.race([
      runShutdownHooks(),
      new Promise((resolve) => setTimeout(resolve, Math.max(500, Math.floor(SHUTDOWN_TIMEOUT_MS / 2)))),
    ]);

    // 2) First attempt unified stop via API (ensures consumer also stops and subs deleted)
    const stopOk = await Promise.race([
      postUnifiedStop(`process_${signal}`),
      new Promise((resolve) => setTimeout(() => resolve(false), Math.max(500, Math.floor(SHUTDOWN_TIMEOUT_MS / 2)))),
    ]);

    // 3) If unified stop is not available or fails, fall back to direct lock release
    if (!stopOk) {
      await Promise.race([
        releaseProjectLock(`process_${signal}`),
        new Promise((resolve) => setTimeout(resolve, Math.max(500, Math.floor(SHUTDOWN_TIMEOUT_MS / 2)))),
      ]);
    }
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
