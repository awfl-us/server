// Internal Jobs endpoint. Its Cloud Run service uses
// --no-allow-unauthenticated; workflowsUserInject has already trusted the
// upstream IAM-authenticated service and extracted the forwarded user ID.
import express from 'express';
import { getFirestore } from 'firebase-admin/firestore';
import { Storage } from '@google-cloud/storage';
import { NativeExecutionStore } from '../workflows/native/executionStore.js';
import { NativeGcsReleases } from '../workflows/native/gcsReleases.js';
import { createJobsEffectHandlers } from '../workflows/native/jobsEffects.js';
import { runNativeWorkflow } from '../workflows/native/worker.js';
import { createNativeProfiler } from '../workflows/native/profiler.js';

export function createNativeJobsRouter({
  store, releases, handlers, execute = runNativeWorkflow,
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
      const nativeStore = store || new NativeExecutionStore({ db: getFirestore() });
      const nativeReleases = releases || new NativeGcsReleases({
        storage: new Storage(), bucket: process.env.AWFL_NATIVE_ARTIFACT_BUCKET,
      });
      const nativeHandlers = handlers || createJobsEffectHandlers({
        jobsOrigin: process.env.AWFL_NATIVE_JOBS_URL,
        profiler,
      });
      const result = await execute({
        executionId, userId, projectId,
        store: profiler ? profiler.store(nativeStore) : nativeStore,
        releases: profiler ? profiler.releases(nativeReleases) : nativeReleases,
        handlers: profiler ? profiler.handlers(nativeHandlers) : nativeHandlers,
        profiler,
      });
      profiler?.report('completed');
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

export default createNativeJobsRouter();
