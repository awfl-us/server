// Internal Jobs endpoint. Its Cloud Run service uses
// --no-allow-unauthenticated; workflowsUserInject has already trusted the
// upstream IAM-authenticated service and extracted the forwarded user ID.
import express from 'express';
import { trace } from '@opentelemetry/api';
import { getFirestore } from 'firebase-admin/firestore';
import { getDocumentStorage } from '../storage/service.js';
import { Storage } from '@google-cloud/storage';
import { NativeExecutionStore } from '../workflows/native/executionStore.js';
import { NativeGcsReleases } from '../workflows/native/gcsReleases.js';
import { createJobsEffectHandlers } from '../workflows/native/jobsEffects.js';
import { runNativeWorkflow } from '../workflows/native/worker.js';
import { runNativeMemoryWorkflow, nativeMemoryAsyncSchedulerFor } from '../workflows/native/memoryWorker.js';
import { createNativeProfiler } from '../workflows/native/profiler.js';
import { createNativeAsyncScheduler } from '../workflows/native/asyncScheduler.js';
import { configuredNativeMemoryStore, nativeDocumentStoreEnabled } from '../storage/nativeMemory.js';
import { nativeCallbacksUseLegacyFirestore } from '../workflows/native/callbackEffects.js';

// Shared only by requests executing in the same trusted Jobs process.
// GCS mappings remain authoritative and digest verification is repeated.
const verifiedNativeArtifacts = new Map();

export function createNativeJobsRouter({
  store, memoryStore, releases, handlers, execute = runNativeWorkflow,
  executeMemory = runNativeMemoryWorkflow,
} = {}) {
  const router = express.Router();
  router.post('/execute', async (req, res) => {
    if (process.env.AWFL_NATIVE_EXECUTION_ENABLED !== '1') {
      return res.status(404).json({ error: 'Not Found' });
    }
    let profiler;
    try {
      const { executionId } = req.body || {};
      const userId = req.userId, projectId = req.projectId;
      if (typeof executionId !== 'string' ||
          !/^native_[a-f0-9]{32}$/.test(executionId) ||
          !userId || !projectId) {
        return res.status(400).json({ error: 'invalid trusted native task' });
      }
      // Opt-in for isolated benchmarking only; never expose timings or
      // internal execution detail to the HTTP caller.
      profiler = createNativeProfiler({
        enabled: process.env.AWFL_NATIVE_PROFILE_ENABLED === '1', executionId,
      });
      // The pilot memory-root execution store can be injected for isolated tests.
      // Production keeps using NativeExecutionStore unless explicitly composed.
      if (nativeDocumentStoreEnabled() && req.body.executionMode !== 'memory') {
        throw new Error('document Storage supports memory-mode executions only');
      }
      const resolvedMemoryStore = req.body.executionMode === 'memory'
        ? (memoryStore || await configuredNativeMemoryStore()) : null;
      const nativeStore = resolvedMemoryStore ||
        (store || new NativeExecutionStore({ db: getFirestore() }));
      const nativeReleases = releases || new NativeGcsReleases({
        storage: new Storage(), bucket: process.env.AWFL_NATIVE_ARTIFACT_BUCKET,
        verifiedCache: verifiedNativeArtifacts,
      });
      const nativeHandlers = handlers || createJobsEffectHandlers({
        jobsOrigin: process.env.AWFL_NATIVE_JOBS_URL,
        profiler, storage: new Storage(),
        ...(nativeCallbacksUseLegacyFirestore()
          ? { callbackDb: getFirestore() }
          : { callbackStorage: await getDocumentStorage() }),
      });
      const span = trace.getActiveSpan();
      if (span?.isRecording()) {
        span.setAttribute('awfl.execution_id', executionId);
        span.setAttribute('awfl.execution_mode', req.body.executionMode === 'memory' ? 'memory' : 'durable');
      }
      const executionMode = req.body.executionMode === 'memory' ? 'memory' : 'durable';
      const storageBackend = resolvedMemoryStore
        ? process.env.AWFL_DOCUMENT_STORAGE_BACKEND || 'firestore' : 'firestore';
      console.info(JSON.stringify({ severity: 'INFO',
        event: 'awfl_native_execution_started', executionId, projectId,
        executionMode, storageBackend,
        documentStoreEnabled: nativeDocumentStoreEnabled(),
      }));
      const runner = executionMode === 'memory' ? executeMemory : execute;
      const result = await runner({
        executionId, userId, projectId,
        store: profiler ? profiler.store(nativeStore) : nativeStore,
        releases: profiler ? profiler.releases(nativeReleases) : nativeReleases,
        handlers: profiler ? profiler.handlers(nativeHandlers) : nativeHandlers,
        profiler,
      });
      if (result?.status === 'failed') {
        profiler?.report('failed');
        console.error(JSON.stringify({
          event: 'awfl_native_execution_failed', executionId, projectId,
          executionMode, storageBackend, errorCode: result.error?.code ?? null,
          errorMessage: result.error?.message ?? String(result.error ?? 'unknown failure'),
        }));
        return res.status(200).json({ state: 'FAILED' });
      }
      if (result?.status === 'cancelled') {
        profiler?.report('cancelled');
        return res.status(200).json({ state: 'CANCELLED' });
      }
      profiler?.report('completed');
      console.info(JSON.stringify({ severity: 'INFO',
        event: 'awfl_native_execution_completed', executionId, projectId,
        executionMode, storageBackend }));
      return res.status(200).json({ state: 'SUCCEEDED', result });
    } catch (error) {
      profiler?.report('error');
      console.error('Native Jobs execution error:', error?.message || error);
      // Cloud Tasks retries 5xx after transient failure; the Firestore
      // checkpoint and effect reconciliation policy prevent blind replay.
      return res.status(503).json({ error: 'Native execution unavailable' });
    }
  });
  return router;
}

// Firestore hosts both durable roots and memory roots until the native
// document-store switch is enabled. One recovery scanner must dispatch by the
// *persisted* executionMode, not the current global feature flag.
const hybridSchedulers = new WeakMap();
export function nativeHybridAsyncSchedulerFor({
  store, releases, handlers,
  executeDurable = runNativeWorkflow, executeMemory = runNativeMemoryWorkflow,
}) {
  const key = store?.db || store;
  if (!key || typeof store?.get !== 'function' ||
      typeof store?.listPendingAsync !== 'function') {
    throw new Error('native hybrid recovery requires a persistent store');
  }
  let scheduler = hybridSchedulers.get(key);
  if (!scheduler) {
    // Old memory detached launches were missing executionMode entirely.
    // Quarantine when the parent proves they belong to memory mode; never run
    // them as durable by accident. A new launch is tagged correctly.
    const quarantined = new Map();
    scheduler = createNativeAsyncScheduler({
      store,
      execute: async ({ executionId, userId, projectId }) => {
        if ((quarantined.get(executionId) || 0) > Date.now()) return;
        quarantined.delete(executionId);
        const state = await store.get(executionId);
        if (!state || state.userId !== userId || state.projectId !== projectId) {
          throw new Error('native detached recovery owner mismatch');
        }
        const params = { store, releases, handlers, executionId, userId,
          projectId, asyncScheduler: scheduler };
        if (state.executionMode === 'memory') {
          return executeMemory(params);
        }
        if (state.executionMode) {
          throw new Error('unsupported native detached execution mode');
        }
        if (state.detachedParentExecutionId) {
          const parent = await store.get(state.detachedParentExecutionId);
          if (!parent || parent.executionMode === 'memory') {
            quarantined.set(executionId, Date.now() + 5 * 60_000);
            console.error(JSON.stringify({ severity: 'ERROR',
              event: 'awfl_native_legacy_detached_mode_missing', executionId,
              parentExecutionId: state.detachedParentExecutionId,
              projectId, workflow: state.workflowName,
              errorMessage: !parent
                ? 'Detached parent record missing; cannot safely choose execution mode'
                : 'Legacy memory detached child missing executionMode; relaunch or repair before recovery',
            }));
            return;
          }
        }
        return executeDurable({ ...params, maxTransitions: 10000 });
      },
    });
    hybridSchedulers.set(key, scheduler);
    scheduler.start();
  }
  return scheduler;
}

// The persistent GKE Jobs deployment can recover queued native detached
// executions immediately on startup, without Cloud Tasks or another service.
// Do not run a detached recovery loop on request-scoped Cloud Run instances.
export function startNativeDetachedRecovery({ store, releases, handlers } = {}) {
  // Cloud Run Jobs can enqueue detached children, but only the always-on GKE
  // worker may scan and recover them after process restarts.
  if (process.env.AWFL_NATIVE_EXECUTION_ENABLED !== '1' ||
      process.env.AWFL_NATIVE_DETACHED_GKE_ENABLED !== '1' ||
      process.env.AWFL_NATIVE_PERSISTENT_WORKER !== '1') return null;
  const nativeReleases = releases || new NativeGcsReleases({
    storage: new Storage(), bucket: process.env.AWFL_NATIVE_ARTIFACT_BUCKET,
    verifiedCache: verifiedNativeArtifacts,
  });
  if (nativeDocumentStoreEnabled()) {
    // Native memory roots and detached children use the *same* selected
    // Storage/pool, including callback records. No Firestore recovery scan.
    return (async () => {
      const nativeStore = store || await configuredNativeMemoryStore();
      const nativeHandlers = handlers || createJobsEffectHandlers({
        jobsOrigin: process.env.AWFL_NATIVE_JOBS_URL,
        storage: new Storage(), callbackStorage: await getDocumentStorage(),
      });
      return nativeMemoryAsyncSchedulerFor({
        store: nativeStore, releases: nativeReleases, handlers: nativeHandlers,
      });
    })();
  }
  const nativeStore = store || new NativeExecutionStore({ db: getFirestore() });
  // The existing durable Firestore execution journal remains supported only
  // while the document-provider-native memory flag is disabled.
  const nativeHandlers = handlers || createJobsEffectHandlers({
    jobsOrigin: process.env.AWFL_NATIVE_JOBS_URL,
    storage: new Storage(), callbackDb: getFirestore(),
  });
  // Recovery must honor each persisted record even if this GKE process has
  // an older/missing memory-mode flag. Never infer a record's mode globally.
  return nativeHybridAsyncSchedulerFor({ store: nativeStore,
    releases: nativeReleases, handlers: nativeHandlers });
}

export default createNativeJobsRouter();
