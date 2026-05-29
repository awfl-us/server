import express from 'express';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { projectScopedCollectionPath } from '../userAuth.js';

const router = express.Router();
const db = getFirestore();

const LLM_USAGE_DEBUG = process.env.LLM_USAGE_DEBUG === '1';
const DEFAULT_WORKFLOW_NAME = process.env.LLM_USAGE_DEFAULT_WORKFLOW || 'default';

function dbg(...args) {
  if (LLM_USAGE_DEBUG) console.log('[llm.usage][debug]', ...args);
}

function hourBucket(dateLike) {
  let d;

  const parseYMDHToDate = (s) => {
    if (!/^\d{10}$/.test(s)) return null;
    const y = Number(s.slice(0, 4));
    const mo = Number(s.slice(4, 6)) - 1; // 0-11
    const da = Number(s.slice(6, 8));
    const h = Number(s.slice(8, 10));
    return new Date(Date.UTC(y, mo, da, h, 0, 0, 0));
  };

  if (dateLike == null) {
    d = new Date();
  } else if (dateLike instanceof Date) {
    d = new Date(dateLike.getTime());
  } else if (typeof dateLike === 'number') {
    d = new Date(dateLike);
  } else if (typeof dateLike === 'string') {
    d = parseYMDHToDate(dateLike) || new Date(dateLike);
  } else {
    d = new Date(dateLike);
  }

  if (isNaN(d.getTime())) {
    throw new Error('Invalid date; expected millis, ISO string, or YYYYMMDDHH');
  }

  // Normalize to the start of the hour in UTC to keep buckets consistent across time zones
  d.setUTCMinutes(0, 0, 0);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const hourKey = `${yyyy}${mm}${dd}${hh}`;
  return {
    date: d,
    hourKey,
    ts: Timestamp.fromDate(d)
  };
}

function toNumber(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

function buildUsageIncrements(usage = {}) {
  const u = usage || {};
  const inc = {};
  const add = (path, val) => {
    const n = toNumber(val);
    if (!n) return;
    inc[path] = FieldValue.increment(n);
  };
  // Top-level known fields (nested under usage.*)
  add('usage.total_tokens', u.total_tokens);
  add('usage.prompt_tokens', u.prompt_tokens);
  add('usage.completion_tokens', u.completion_tokens);

  // Nested details if present
  const p = u.prompt_tokens_details || {};
  if (p) {
    add('usage.prompt_tokens_details.cached_tokens', p.cached_tokens);
    add('usage.prompt_tokens_details.audio_tokens', p.audio_tokens);
  }
  const c = u.completion_tokens_details || {};
  if (c) {
    add('usage.completion_tokens_details.reasoning_tokens', c.reasoning_tokens);
    add('usage.completion_tokens_details.audio_tokens', c.audio_tokens);
    add('usage.completion_tokens_details.accepted_prediction_tokens', c.accepted_prediction_tokens);
    add('usage.completion_tokens_details.rejected_prediction_tokens', c.rejected_prediction_tokens);
  }
  return inc;
}

export async function incrementUsage({ userId, projectId, sessionId, workflowName, usage, totalCost, timestamp }) {
  try {
    // Default the workflow when omitted to avoid silent drops
    const wf = workflowName || DEFAULT_WORKFLOW_NAME;

    if (!userId || !projectId || !sessionId) {
      dbg('skip write: missing context', { hasUserId: !!userId, hasProjectId: !!projectId, hasSessionId: !!sessionId, workflowName: wf });
      return; // graceful no-op
    }

    const { hourKey, ts } = hourBucket(timestamp);

    const basePath = projectScopedCollectionPath(userId, projectId, `convo.sessions/${sessionId}/llm.usage`);
    const docId = `${wf}__${hourKey}`;
    const ref = db.collection(basePath).doc(docId);

    const updates = {
      workflow_name: wf,
      userId,
      projectId,
      sessionId,
      hour_start: ts,
      hour_key: hourKey,
      last_updated: FieldValue.serverTimestamp(),
      requests: FieldValue.increment(1)
    };

    const usageIncs = buildUsageIncrements(usage);
    Object.assign(updates, usageIncs);

    if (typeof totalCost === 'number' && isFinite(totalCost)) {
      updates.total_cost = FieldValue.increment(totalCost);
    }

    dbg('writing usage increment', { basePath, docId, hourKey, hasUsage: !!usage, hasCost: typeof totalCost === 'number' });
    await ref.set(updates, { merge: true });
  } catch (err) {
    console.error('[llm.usage] incrementUsage failed:', err?.message || err);
  }
}

// Aggregator strictly matches the write shape: totals are under `usage.*` only
function addUsageAgg(target, u = {}) {
  const t = target;
  // Aggregate top-level counters
  t.requests = (t.requests || 0) + toNumber(u.requests);
  t.total_cost = (t.total_cost || 0) + toNumber(u.total_cost);

  // Ensure normalized usage shape on target
  t.usage = t.usage || {
    total_tokens: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 }
  };

  // Read strictly from nested `u.usage` per current write path
  const src = (u && typeof u === 'object' && u.usage && typeof u.usage === 'object') ? u.usage : {};

  t.usage.total_tokens += toNumber(src.total_tokens);
  t.usage.prompt_tokens += toNumber(src.prompt_tokens);
  t.usage.completion_tokens += toNumber(src.completion_tokens);

  const pd = (src && src.prompt_tokens_details) || {};
  t.usage.prompt_tokens_details.cached_tokens += toNumber(pd.cached_tokens);
  t.usage.prompt_tokens_details.audio_tokens += toNumber(pd.audio_tokens);

  const cd = (src && src.completion_tokens_details) || {};
  t.usage.completion_tokens_details.reasoning_tokens += toNumber(cd.reasoning_tokens);
  t.usage.completion_tokens_details.audio_tokens += toNumber(cd.audio_tokens);
  t.usage.completion_tokens_details.accepted_prediction_tokens += toNumber(cd.accepted_prediction_tokens);
  t.usage.completion_tokens_details.rejected_prediction_tokens += toNumber(cd.rejected_prediction_tokens);

  return t;
}

export async function getSessionTotals({ userId, projectId, sessionId }) {
  if (!userId || !projectId || !sessionId) throw new Error('userId, projectId, sessionId are required');
  const basePath = projectScopedCollectionPath(userId, projectId, `convo.sessions/${sessionId}/llm.usage`);
  const snap = await db.collection(basePath).get();

  const totals = {};
  const overall = { requests: 0, total_cost: 0, usage: undefined };

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    // overall
    addUsageAgg(overall, data);
    // per-workflow
    const wf = data.workflow_name || 'unknown';
    totals[wf] = totals[wf] || { requests: 0, total_cost: 0, usage: undefined };
    addUsageAgg(totals[wf], data);
  }

  return { overall, by_workflow: totals };
}

export async function getProjectHourly({ userId, projectId, start, end }) {
  if (!userId || !projectId) throw new Error('userId and projectId are required');
  const { ts: startTs } = hourBucket(start);

  let endTs;
  if (end) {
    if (typeof end === 'string' && /^\d{10}$/.test(end)) {
      // Make end inclusive of the provided hour by advancing to the next hour (exclusive upper bound)
      const endHour = hourBucket(end).date;
      const endExclusive = new Date(endHour.getTime() + 60 * 60 * 1000);
      endTs = Timestamp.fromDate(endExclusive);
    } else {
      endTs = hourBucket(end).ts;
    }
  } else {
    endTs = hourBucket(Date.now()).ts;
  }

  // Query collection group across all session usage docs; filter by projectId/userId and hour range
  const q = db.collectionGroup('llm.usage')
    .where('userId', '==', userId)
    .where('projectId', '==', projectId)
    .where('hour_start', '>=', startTs)
    .where('hour_start', '<', endTs);

  const snap = await q.get();

  const buckets = {}; // { [hour_key]: { [workflow_name]: agg } }

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const h = data.hour_key || 'unknown';
    const wf = data.workflow_name || 'unknown';
    buckets[h] = buckets[h] || {};
    buckets[h][wf] = buckets[h][wf] || { requests: 0, total_cost: 0, usage: undefined };
    addUsageAgg(buckets[h][wf], data);
  }

  return { buckets };
}

// Routes: totals requires :sessionId param; project/hourly uses header-only projectId
router.get('/:sessionId/totals', async (req, res) => {
  try {
    const userId = req.userId; // injected by workflowsUserInject
    const projectId = req.projectId; // from middleware/header
    const { sessionId } = req.params; // required path param

    if (!userId || !projectId) return res.status(400).json({ error: 'Missing userId/projectId context' });
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId param' });

    const data = await getSessionTotals({ userId, projectId, sessionId });
    return res.status(200).json(data);
  } catch (err) {
    console.error('[llm.usage] /:sessionId/totals error', err?.message || err);
    return res.status(500).json({ error: 'Failed to fetch session totals' });
  }
});

router.get('/project/hourly', async (req, res) => {
  try {
    const userId = req.userId;
    const projectId = req.projectId; // header-only
    if (!userId || !projectId) return res.status(400).json({ error: 'Missing userId/projectId context' });

    const { start, end } = req.query || {};
    if (!start) return res.status(400).json({ error: 'Missing start query param (YYYYMMDDHH, ISO string, or millis)' });

    const data = await getProjectHourly({ userId, projectId, start, end });
    return res.status(200).json(data);
  } catch (err) {
    console.error('[llm.usage] /project/hourly error', err?.message || err);
    // If this looks like a bad date input, surface 400
    if (typeof err?.message === 'string' && err.message.startsWith('Invalid date')) {
      return res.status(400).json({ error: 'Invalid start/end; expected YYYYMMDDHH, ISO string, or millis' });
    }
    return res.status(500).json({ error: 'Failed to fetch project hourly aggregates' });
  }
});

export default router;
