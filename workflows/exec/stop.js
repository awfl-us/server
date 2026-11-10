import express from 'express';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { ExecutionsClient } from '@google-cloud/workflows';
import { getUserIdFromReq, projectScopedCollectionPath } from '../utils.js';
import { COLLECTIONS, withEnvSuffix } from './shared.js';

const router = express.Router();

// POST /workflows/exec/stop
// Body: { userId?: string, execId: string, workflow?: string, workflows?: string[], includeDescendants?: boolean }
// Note: userId may be supplied by trusted internal callers; otherwise inferred via getUserIdFromReq
// Traverses ancestors (parents) of the provided execId and, optionally, descendants, then attempts to cancel all corresponding Google Workflow executions.
export async function cancelExecutionChain({ userId, projectId, execId, workflow, workflows, includeDescendants }) {
  if (!userId || !projectId) throw new Error('User and project are required');
  if (!execId || typeof execId !== 'string') {
    return { status: 400, body: { error: 'Missing required field: execId' } };
  }
    const includeDesc = Boolean(includeDescendants);

    const db = getFirestore();
    const linksCollection = projectScopedCollectionPath(userId, projectId, COLLECTIONS.links);
    const regsCollection = projectScopedCollectionPath(userId, projectId, COLLECTIONS.regs);
    const statusesCollection = projectScopedCollectionPath(userId, projectId, COLLECTIONS.statuses);
    const locksCollection = projectScopedCollectionPath(userId, projectId, COLLECTIONS.locksConvoSession);

    // Try to resolve the originating sessionId for this execId
    const sessionIds = new Set();
    try {
      const regByExecSnap = await db
        .collection(regsCollection)
        .where('execId', '==', execId)
        .limit(1)
        .get();
      if (!regByExecSnap.empty) {
        const s = String((regByExecSnap.docs[0].data() || {}).sessionId || '');
        if (s) sessionIds.add(s);
      }
    } catch (_e) {
      // Non-fatal if query fails; we'll try to infer from links during traversal
    }

    // Build ancestor set starting from execId, moving upward via triggeredExec -> callingExec
    // If includeDescendants is true, also traverse downward via callingExec -> triggeredExec
    const toVisit = [execId];
    const toCancel = new Set();
    const visited = new Set();

    while (toVisit.length > 0) {
      const current = toVisit.shift();
      if (!current || visited.has(current)) continue;
      visited.add(current);
      toCancel.add(current);

      // Find all parents where triggeredExec == current
      const parentsSnap = await db
        .collection(linksCollection)
        .where('triggeredExec', '==', current)
        .get();
      for (const doc of parentsSnap.docs) {
        const data = doc.data() || {};
        const calling = String(data.callingExec || '');
        const sid = String(data.sessionId || '');
        if (sid) sessionIds.add(sid);
        if (calling && !visited.has(calling)) toVisit.push(calling);
      }

      if (includeDesc) {
        // Find all children where callingExec == current
        const childrenSnap = await db
          .collection(linksCollection)
          .where('callingExec', '==', current)
          .get();
        for (const doc of childrenSnap.docs) {
          const data = doc.data() || {};
          const child = String(data.triggeredExec || '');
          const sid = String(data.sessionId || '');
          if (sid) sessionIds.add(sid);
          if (child && !visited.has(child)) toVisit.push(child);
        }
      }
    }

    if (toCancel.size === 0) {
      return { status: 404, body: { error: 'No related executions found to cancel' } };
    }

    const gcpProjectId = process.env.GCP_PROJECT || process.env.GCLOUD_PROJECT;
    if (!gcpProjectId) {
      return { status: 500, body: { error: 'GCP project ID is not configured' } };
    }
    const region = process.env.WORKFLOWS_LOCATION || 'us-central1';

    // Determine candidate workflows to try for cancellation.
    // Combine explicit request body (workflow/workflows) with env WORKFLOWS_CANCEL_WORKFLOWS, applying the same WORKFLOW_ENV suffixing used by /execute.
    const bodyWorkflowsRaw = [];
    if (typeof workflow === 'string') bodyWorkflowsRaw.push(workflow.trim());
    if (Array.isArray(workflows)) {
      for (const w of workflows) {
        if (w != null) bodyWorkflowsRaw.push(String(w).trim());
      }
    }

    // Apply suffix conditionally to provided workflow names
    const providedWorkflows = bodyWorkflowsRaw.filter(Boolean).map(withEnvSuffix);

    const configured = (process.env.WORKFLOWS_CANCEL_WORKFLOWS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // Apply suffix conditionally to configured workflow names as well
    const envWorkflows = configured.map(withEnvSuffix);

    // Merge provided (first) then env-derived, de-duplicated
    const seen = new Set();
    const workflowsToTry = [];
    for (const w of [...providedWorkflows, ...envWorkflows]) {
      if (w && !seen.has(w)) {
        seen.add(w);
        workflowsToTry.push(w);
      }
    }

    // Preload workflow names from status documents per execId (preferred per-exec candidate)
    const statusWorkflowByExec = new Map();
    for (const id of toCancel) {
      try {
        const snap = await db.collection(statusesCollection).doc(String(id)).get();
        const wf = (snap.exists ? (snap.get('workflow') || '') : '') || '';
        const wfNorm = wf ? withEnvSuffix(String(wf)) : '';
        statusWorkflowByExec.set(String(id), wfNorm);
      } catch (_e) {
        statusWorkflowByExec.set(String(id), '');
      }
    }

    const anyStatusWorkflow = Array.from(statusWorkflowByExec.values()).some((v) => Boolean(v));

    if (!anyStatusWorkflow && workflowsToTry.length === 0) {
      return { status: 400, body: {
        error: 'No workflows provided, WORKFLOWS_CANCEL_WORKFLOWS not configured, and no workflow recorded in status',
        hint: 'Ensure workflowExecStatus.workflow is recorded, or pass body.workflow/workflows, or set WORKFLOWS_CANCEL_WORKFLOWS',
      } };
    }

    const client = new ExecutionsClient();

    const results = [];
    for (const id of toCancel) {
      const attempts = [];
      let cancelled = false;

      // Build per-exec candidate list: prefer status.workflow, then provided/env
      const perExecSeen = new Set();
      const perExecCandidates = [];
      const preferred = statusWorkflowByExec.get(String(id));
      if (preferred) {
        perExecSeen.add(preferred);
        perExecCandidates.push(preferred);
      }
      for (const wf of workflowsToTry) {
        if (!perExecSeen.has(wf)) {
          perExecSeen.add(wf);
          perExecCandidates.push(wf);
        }
      }

      // If still no candidates (should be rare due to earlier check), skip gracefully
      if (perExecCandidates.length === 0) {
        results.push({ execId: id, cancelled: false, attempts: [{ ok: false, error: 'no-candidate-workflows' }] });
        continue;
      }

      for (const wf of perExecCandidates) {
        const name = client.executionPath(gcpProjectId, region, wf, id);
        try {
          await client.cancelExecution({ name });
          attempts.push({ workflow: wf, name, ok: true });
          cancelled = true;
          break; // stop after first success
        } catch (e) {
          const code = e?.code ?? e?.response?.status;
          const msg = e?.message || String(e);
          // Treat NOT_FOUND (404 or gRPC code 5) as a successful cancellation: execution no longer exists
          if (code === 404 || code === 5) {
            attempts.push({ workflow: wf, name, ok: true, treatedAsCancelled: true, code, note: 'Execution not found; marking as Cancelled' });
            cancelled = true;
            break; // stop after first treated-as-success
          }
          // Treat FAILED_PRECONDITION (gRPC code 9) where state is SUCCEEDED as success for our purposes
          if (code === 9) {
            attempts.push({ workflow: wf, name, ok: true, treatedAsCancelled: true, code, note: 'Execution already completed; marking as Cancelled' });
            cancelled = true;
            break; // stop after first treated-as-success
          }
          attempts.push({ workflow: wf, name, ok: false, code, error: msg });
        }
      }

      // If cancelled, update stored status to 'Cancelled'
      if (cancelled) {
        try {
          await db.collection(statusesCollection).doc(id).set(
            { status: 'Cancelled', updated: Timestamp.now() },
            { merge: true }
          );
        } catch (e) {
          // Non-fatal; include a note in attempts for visibility
          attempts.push({ ok: false, error: `status-update-failed: ${e?.message || String(e)}` });
        }
      }

      results.push({ execId: id, cancelled, attempts });
    }

    // Attempt to release convo session locks for all discovered sessionIds
    const lockReleases = [];
    for (const sid of sessionIds) {
      try {
        await db.collection(locksCollection).doc(sid).delete();
        lockReleases.push({ sessionId: sid, ok: true });
      } catch (e) {
        lockReleases.push({ sessionId: sid, ok: false, error: e?.message || String(e) });
      }
    }

    const anyCancelled = results.some((r) => r.cancelled);
    const status = anyCancelled ? 200 : 404;

    return { status, body: { projectId: gcpProjectId, region, includeDescendants: includeDesc,
      workflowsTried: workflowsToTry, results, lockReleases } };
}

router.post('/stop', async (req, res) => {
  try {
    const userId = await getUserIdFromReq(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing or invalid user token' });
    const { execId, workflow, workflows, includeDescendants } = req.body || {};
    const result = await cancelExecutionChain({
      userId, projectId: req.projectId, execId, workflow, workflows, includeDescendants,
    });
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('Error stopping exec chain:', err);
    return res.status(500).json({ error: 'Failed to stop exec chain', details: err?.message || String(err) });
  }
});

export default router;
