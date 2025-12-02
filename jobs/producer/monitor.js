import { stopContainer, waitContainer } from './docker.js';
import { releaseConsumerLock } from '../../workflows/projects/lock.js';

const activeMonitors = new Map(); // key: producer container name/id => { sidecarName, userId, projectId, consumerId }
let signalsWired = false;

function wireSignalsOnce() {
  if (signalsWired) return;
  signalsWired = true;
  const cleanup = async (signal) => {
    try { console.log('[jobs/producer] signal', { signal, active: activeMonitors.size }); } catch {}
    const entries = Array.from(activeMonitors.entries());
    for (const [_key, ctx] of entries) {
      try { if (ctx.sidecarName) await stopContainer(ctx.sidecarName); } catch {}
      try {
        if (ctx.userId && ctx.projectId && ctx.consumerId) {
          await releaseConsumerLock({ userId: ctx.userId, projectId: ctx.projectId, consumerId: ctx.consumerId });
        }
      } catch {}
    }
    activeMonitors.clear();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

export async function startExitMonitor({ producerKey, sidecarName, userId, projectId, consumerId }) {
  if (!producerKey) return;
  if (activeMonitors.has(producerKey)) return; // avoid duplicates
  activeMonitors.set(producerKey, { sidecarName, userId, projectId, consumerId });
  wireSignalsOnce();

  (async () => {
    try { console.log('[jobs/producer] monitor:start', { producer: producerKey, sidecar: sidecarName || null, consumerId }); } catch {}

    const result = await waitContainer(producerKey);

    try { console.log('[jobs/producer] monitor:producer_exit', { producer: producerKey, result }); } catch {}

    if (sidecarName) {
      try { await stopContainer(sidecarName); } catch {}
    }

    try {
      if (userId && projectId && consumerId) {
        await releaseConsumerLock({ userId, projectId, consumerId });
      }
    } catch {}
  })().finally(() => {
    activeMonitors.delete(producerKey);
    try { console.log('[jobs/producer] monitor:done', { producer: producerKey }); } catch {}
  });
}
