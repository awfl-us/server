import { getConsumerLock } from '../../workflows/projects/lock.js';
import { cancelStartupProgress } from './progress.js';
import { stopByRuntime } from './paths/stop.js';

// Shared project shutdown service. Both the regular /producer/stop route and
// MCP workspace_stop call this exact function, preserving one lifecycle.
export async function stopProjectConsumer({ userId, projectId }, {
  getLock = getConsumerLock,
  stop = stopByRuntime,
  cancelProgress = cancelStartupProgress,
} = {}) {
  if (!userId) return { status: 401, body: { error: 'Unauthorized: missing user context' } };
  if (!projectId) return { status: 400, body: { error: 'Missing project ID' } };

  const { ok, lock } = await getLock({ userId, projectId });
  if (!ok) return { status: 500, body: { error: 'Failed to read project consumer lock' } };
  if (!lock) return { status: 200, body: { ok: true, consumerStopped: false, message: 'No active lock' } };

  try { cancelProgress({ userId, projectId, reason: 'stop requested' }); } catch {}
  const result = await stop({ userId, projectId, lock });
  return {
    ...result,
    body: { ...result.body, consumerStopped: Boolean(result.body?.ok) },
  };
}
