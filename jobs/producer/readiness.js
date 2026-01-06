// Cloud Run startup readiness monitor
// - Polls LROs to discover execution names
// - Polls executions for state and updates project.status_message with concise status
// - Clears status_message as soon as both jobs have started (>= starting); no "Running…" status emitted

import { getOperation, getExecutionByName } from './cloudRun.js';
import { setStartupStatus, completeStartupProgress } from './progress.js';

function stateOfExecution(exec) {
  if (!exec) return 'queued';
  const conditions = Array.isArray(exec.conditions) ? exec.conditions : [];
  const completed = conditions.find((c) => c?.type === 'Completed');
  const runningCount = Number(exec.runningCount || 0);
  // If any tasks are running (for multi-task jobs), treat as running
  if (runningCount > 0) return 'running';
  // Treat presence of startTime as "starting"
  if (exec.startTime) return 'starting';
  // Cloud Run v2 typically uses STATE_TRUE/STATE_FALSE, not SUCCEEDED/FAILED strings
  if (completed && String(completed.state || '').toUpperCase().includes('TRUE')) return 'running';
  if (exec.completionTime) return 'running';
  return 'queued';
}

// Track operations we've already warned about to avoid log spam
const warnedOps = new Set();

async function resolveExecutionName(opName) {
  if (!opName) return null;
  try {
    const op = await getOperation({ name: opName });
    if (!op?.ok) {
      if (!warnedOps.has(opName)) {
        console.warn('[readiness] getOperation !ok', { name: opName, status: op?.status, data: op?.data });
        warnedOps.add(opName);
      }
      return null;
    }
    const data = op.data || {};

    // Prefer metadata.target if present (available before operation is done)
    // Example: projects/.../locations/.../jobs/.../executions/exec-123
    const meta = data.metadata || {};
    if (typeof meta.target === 'string' && meta.target.includes('/executions/')) return meta.target;
    if (typeof meta.name === 'string' && meta.name.includes('/executions/')) return meta.name;

    // If the operation has completed, response.name may also contain the execution resource name
    if (data.done && data.response?.name) return data.response.name;
  } catch (e) {
    if (!warnedOps.has(opName)) {
      console.warn('[readiness] getOperation error', { name: opName, err: e?.message || String(e) });
      warnedOps.add(opName);
    }
  }
  return null;
}

export async function monitorCloudRunStartup({
  userId,
  projectId,
  producerOperationName,
  consumerOperationName,
  timeoutMs = 90_000,
}) {
  const start = Date.now();
  let prodExecName = null;
  let consExecName = null;
  let lastBase = null;

  // Warn-once sets for execution fetches
  const warnedExecs = new Set();

  // Initial message: explicitly queued/creating
  try {
    await setStartupStatus({ userId, projectId, message: 'Queued/creating cloud compute…' });
    lastBase = 'Queued/creating cloud compute…';
  } catch {}

  const order = { queued: 0, starting: 1, running: 2 };

  const tick = async () => {
    const now = Date.now();

    if (!prodExecName && producerOperationName) prodExecName = await resolveExecutionName(producerOperationName);
    if (!consExecName && consumerOperationName) consExecName = await resolveExecutionName(consumerOperationName);

    let prodExec = null;
    let consExec = null;

    if (prodExecName) {
      try {
        const r = await getExecutionByName({ name: prodExecName });
        if (r?.ok) prodExec = r.data;
        else if (!warnedExecs.has(prodExecName)) {
          console.warn('[readiness] getExecution !ok', { name: prodExecName, status: r?.status, data: r?.data });
          warnedExecs.add(prodExecName);
        }
      } catch (e) {
        if (!warnedExecs.has(prodExecName)) {
          console.warn('[readiness] getExecution error', { name: prodExecName, err: e?.message || String(e) });
          warnedExecs.add(prodExecName);
        }
      }
    }
    if (consExecName) {
      try {
        const r = await getExecutionByName({ name: consExecName });
        if (r?.ok) consExec = r.data;
        else if (!warnedExecs.has(consExecName)) {
          console.warn('[readiness] getExecution !ok', { name: consExecName, status: r?.status, data: r?.data });
          warnedExecs.add(consExecName);
        }
      } catch (e) {
        if (!warnedExecs.has(consExecName)) {
          console.warn('[readiness] getExecution error', { name: consExecName, err: e?.message || String(e) });
          warnedExecs.add(consExecName);
        }
      }
    }

    const ps = stateOfExecution(prodExec);
    const cs = stateOfExecution(consExec);
    const slow = (ps && cs) ? (order[ps] <= order[cs] ? ps : cs) : (ps || cs || 'queued');

    // If both have reached at least "starting", clear the status message immediately
    if (order[slow] >= order['starting']) {
      try { await completeStartupProgress({ userId, projectId, reason: 'cloud-run starting' }); } catch {}
      return true;
    }

    // Otherwise, show concise message per phase (only 'queued' can show here)
    const base = slow === 'queued' ? 'Queued/creating cloud compute…' : 'Starting…';
    if (base !== lastBase) {
      try { await setStartupStatus({ userId, projectId, message: base }); } catch {}
      lastBase = base;
    }

    if (now - start > timeoutMs) {
      // On timeout, clear status and log a single warning with what we know
      try { await completeStartupProgress({ userId, projectId, reason: 'cloud-run timeout' }); } catch {}
      console.warn('[readiness] timeout clearing status', {
        userId,
        projectId,
        prodExecName,
        consExecName,
        elapsedMs: now - start,
        ps,
        cs,
      });
      return true;
    }
    return false;
  };

  let done = false;
  while (!done) {
    try { done = await tick(); } catch { /* best-effort */ }
    if (done) break;
    const waited = Date.now() - start;
    const delay = waited < 30_000 ? 1000 : 2500;
    await new Promise((r) => setTimeout(r, delay));
  }
}

export default { monitorCloudRunStartup };
