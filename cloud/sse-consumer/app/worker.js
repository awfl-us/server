// Pub/Sub consumer worker
// - Subscribes to SUBSCRIPTION for channel=req messages
// - Decrypts payloads using ENC_KEY_B64 and routing AAD
// - Executes tool callbacks (READ_FILE, UPDATE_FILE, RUN_COMMAND, GCS_SYNC)
// - Publishes responses to TOPIC with channel=REPLY_CHANNEL and same seq

import { PubSub } from '@google-cloud/pubsub';
import {
  PUBSUB_ENABLE,
  TOPIC,
  SUBSCRIPTION,
  REPLY_CHANNEL,
  ENC_KEY_B64,
  ENC_VER,
  IDLE_EXIT_MS,
  READ_FILE_MAX_BYTES,
  OUTPUT_MAX_BYTES,
  SYNC_ON_START,
  SYNC_INTERVAL_MS,
} from './config.js';
import { encryptJson, decryptToJson, scheme as encScheme } from './crypto.js';
import { ensureWorkRoot, resolveWithin } from './storage.js';
import { parseToolArgs } from './utils/parse.js';
import { doReadFile, doRunCommand, doUpdateFile } from './tools/index.js';
import { syncBucketPrefix } from './gcs-sync.js';

const CONSUMER_TRACE = /^1|true|yes$/i.test(String(process.env.CONSUMER_TRACE || '1'));
function ctr(...args) { if (CONSUMER_TRACE) console.log('[consumer]', ...args); }

function stableAttrs(base) {
  return {
    user_id: base.user_id || '',
    project_id: base.project_id || '',
    session_id: base.session_id || '',
    channel: base.channel || '',
    type: base.type || '',
    seq: String(base.seq ?? ''),
  };
}

function isCallbackEvent(obj) {
  if (!obj) return false;
  const t = obj?.type || obj?.event || obj?.kind;
  if (t && (String(t).toLowerCase() === 'callback' || String(t).toLowerCase() === 'tool')) return true;
  if (typeof obj?.tool === 'string' && obj.tool) return true;
  if (obj?.tool_call?.function?.name) return true;
  return false;
}

function getToolName(obj) {
  if (obj?.tool_call?.function?.name) return obj.tool_call.function.name;
  return obj?.tool || obj?.name || obj?.callback || obj?.command || obj?.action || obj?.type || 'tool';
}

function getToolArgs(obj) {
  if (obj?.tool_call?.function) return obj.tool_call.function.arguments;
  return obj?.args ?? obj?.arguments ?? obj?.payload?.args ?? obj?.payload;
}

async function handleCallback(ev, { workRoot, gcs }) {
  const id = ev?.id || ev?.event_id || ev?.request_id || null;
  const tool = String(getToolName(ev) || '').toUpperCase();
  const argsRaw = getToolArgs(ev);
  const args = parseToolArgs(argsRaw);

  ctr('tool start', { id, tool });

  try {
    let result;
    if (tool === 'READ_FILE') {
      result = await doReadFile(args, (rel) => resolveWithin(workRoot, rel), { maxBytes: READ_FILE_MAX_BYTES });
    } else if (tool === 'UPDATE_FILE') {
      result = await doUpdateFile(args, (rel) => resolveWithin(workRoot, rel));
    } else if (tool === 'RUN_COMMAND') {
      // Support top-level timeout_seconds on the event object. null => unlimited
      let timeoutSecondsArg;
      if (Object.prototype.hasOwnProperty.call(ev || {}, 'timeout_seconds')) {
        const t = ev.timeout_seconds;
        timeoutSecondsArg = (t === null) ? null : Number(t);
      }
      const runArgs = (timeoutSecondsArg !== undefined) ? { ...args, timeoutSeconds: timeoutSecondsArg } : args;
      result = await doRunCommand(runArgs, workRoot);
    } else if (tool === 'GCS_SYNC' || tool === 'SYNC_GCS' || tool === 'GCS.MIRROR') {
      const bucket = String(args.bucket || gcs?.bucket || '');
      const prefix = String(args.prefix || gcs?.prefix || '');
      const token = String(args.token || gcs?.token || '');
      if (!bucket) throw new Error('GCS_SYNC: missing bucket');
      if (!token) throw new Error('GCS_SYNC: missing token'); // Do not attempt sync without a token
      // Start log mirrors stream route behavior
      console.log('[consumer] gcs sync start', { bucket, prefix, tokenProvided: Boolean(token), kind: 'tool' });
      const stats = await syncBucketPrefix({ bucket, prefix, workRoot, token });
      console.log('[consumer] gcs sync done', { stats, kind: 'tool' });
      result = stats;
    } else {
      result = null; // Unknown tool -> null result per minimization contract
    }
    const payload = id ? { id, result } : { result };
    ctr('tool done', { id, tool, ok: true });
    return payload;
  } catch (err) {
    const payload = id ? { id, result: null, error: String(err?.message || err || 'tool_error') } : { result: null, error: String(err?.message || err || 'tool_error') };
    ctr('tool done', { id, tool, ok: false, error: String(err?.message || err) });
    return payload;
  }
}

async function handleEventObject(obj, ctx) {
  if (obj == null) return { result: null };
  if (isCallbackEvent(obj)) return handleCallback(obj, ctx);
  // Non-callback events: no-op, return null result so producer can advance
  return { result: null };
}

function requireEnv() {
  const missing = [];
  if (!PUBSUB_ENABLE) missing.push('PUBSUB_ENABLE');
  if (!TOPIC) missing.push('TOPIC');
  if (!SUBSCRIPTION) missing.push('SUBSCRIPTION');
  if (!ENC_KEY_B64) missing.push('ENC_KEY_B64');
  if (missing.length) {
    console.error('[consumer] missing required env:', missing.join(','));
    process.exit(2);
  }
}

async function main() {
  requireEnv();

  const pubsub = new PubSub();
  const topic = pubsub.topic(TOPIC);
  const sub = pubsub.subscription(SUBSCRIPTION, {
    flowControl: { maxMessages: 16 },
    enableOpenTelemetryTracing: false,
  });

  // Per-session ephemeral state (in-memory only)
  // session_id -> { gcs: { bucket, prefix, token }, workRoot: string, syncing: boolean }
  const sessionState = new Map();
  const sessionTimers = new Map(); // session_id -> interval handle

  let lastActivity = Date.now();
  let shuttingDown = false;

  function updateActivity() { lastActivity = Date.now(); }

  async function publishReply(attrsIn, payload) {
    const seq = String(attrsIn.seq || '');
    const type = getToolName(payload) || attrsIn.type || 'event';
    const attrs = stableAttrs({
      user_id: attrsIn.user_id,
      project_id: attrsIn.project_id,
      session_id: attrsIn.session_id,
      channel: REPLY_CHANNEL,
      type,
      seq,
    });
    const env = encryptJson(payload, ENC_KEY_B64, attrs);
    const data = Buffer.from(JSON.stringify(env), 'utf8');
    const message = { data, attributes: { ...attrs, v: encScheme() } };
    const messageId = await topic.publishMessage(message);
    ctr('reply published', { seq, messageId });
  }

  async function runOneShotAndSchedulePeriodicSync(sid) {
    const state = sessionState.get(sid);
    if (!state || !state.gcs || !state.gcs.token) return;

    const { bucket, prefix, token } = state.gcs;

    // One-shot sync on bootstrap if enabled
    if (SYNC_ON_START) {
      try {
        state.syncing = true;
        console.log('[consumer] gcs sync start', { bucket, prefix, tokenProvided: Boolean(token), kind: 'start' });
        const stats = await syncBucketPrefix({ bucket, prefix, workRoot: state.workRoot, token });
        console.log('[consumer] gcs sync done', { stats, kind: 'start' });
      } catch (e) {
        console.warn('[consumer] gcs one-shot sync failed', { session: sid, err: String(e?.message || e) });
      } finally {
        state.syncing = false;
      }
    } else {
      console.log('[consumer] gcs sync skipped', { SYNC_ON_START, tokenProvided: true });
    }

    // Periodic sync with overlap guard
    const intervalMs = Number(SYNC_INTERVAL_MS || 0);
    if (intervalMs > 0 && !sessionTimers.has(sid)) {
      const iv = setInterval(async () => {
        const st = sessionState.get(sid);
        if (!st || !st.gcs || !st.gcs.token) return;
        if (st.syncing) return; // prevent overlap
        st.syncing = true;
        try {
          console.log('[consumer] gcs sync start', { bucket: st.gcs.bucket, prefix: st.gcs.prefix, tokenProvided: true, kind: 'interval' });
          const stats = await syncBucketPrefix({ bucket: st.gcs.bucket, prefix: st.gcs.prefix, workRoot: st.workRoot, token: st.gcs.token });
          console.log('[consumer] gcs sync done', { stats, kind: 'interval' });
        } catch (e) {
          console.warn('[consumer] gcs periodic sync failed', { session: sid, err: String(e?.message || e) });
        } finally {
          st.syncing = false;
        }
      }, Math.max(1000, intervalMs));
      sessionTimers.set(sid, iv);
      ctr('gcs periodic sync armed', { session: sid, intervalMs: Math.max(1000, intervalMs) });
    }
  }

  async function onMessage(msg) {
    updateActivity();
    const attrs = msg.attributes || {};
    const channel = attrs.channel || '';
    const seq = String(attrs.seq || '');

    try {
      if (channel !== 'req') { msg.ack(); return; }

      const env = JSON.parse(msg.data.toString('utf8'));
      const request = decryptToJson(env, ENC_KEY_B64, stableAttrs(attrs));

      const workspaceId = request?.workspaceId || request?.workspace_id || 'ws';
      const workRoot = await ensureWorkRoot({
        userId: attrs.user_id,
        projectId: attrs.project_id,
        workspaceId,
        sessionId: attrs.session_id,
      });

      // Capture GCS bootstrap on first message for the session and keep in-memory only
      const sid = String(attrs.session_id || '');
      if (request?.gcs && request.gcs.token) {
        const safe = {
          bucket: String(request.gcs.bucket || ''),
          prefix: String(request.gcs.prefix || ''),
          token: String(request.gcs.token || ''),
        };
        const prev = sessionState.get(sid) || {};
        sessionState.set(sid, { ...prev, gcs: safe, workRoot, syncing: false });
        ctr('gcs bootstrap stored', { session: sid, hasToken: true });
        // Trigger one-shot sync and periodic schedule as per legacy stream route
        await runOneShotAndSchedulePeriodicSync(sid);
      } else {
        // Ensure workRoot is tracked even if no token (for future sync calls)
        const prev = sessionState.get(sid) || {};
        sessionState.set(sid, { ...prev, workRoot, syncing: false });
      }

      const state = sessionState.get(sid);
      const gcsCtx = state ? state.gcs : undefined;
      const payload = await handleEventObject(request, { workRoot, gcs: gcsCtx });
      await publishReply(attrs, payload);
      msg.ack();
    } catch (err) {
      console.warn('[consumer] handle message failed; nacking', { seq, err: String(err?.message || err) });
      try { msg.nack(); } catch {}
    }
  }

  function onError(err) {
    console.warn('[consumer] subscription error', err?.message || err);
  }

  sub.on('message', onMessage);
  sub.on('error', onError);
  console.log('[consumer] worker started', { subscription: SUBSCRIPTION, topic: TOPIC, reply: REPLY_CHANNEL });

  let idleTimer = null;
  function armIdle() {
    if (!IDLE_EXIT_MS) return;
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = setInterval(() => {
      const idleFor = Date.now() - lastActivity;
      if (idleFor >= IDLE_EXIT_MS) {
        console.log('[consumer] idle exit after', idleFor, 'ms');
        shutdown();
      }
    }, Math.min(IDLE_EXIT_MS, 5000));
  }
  armIdle();

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    try { if (idleTimer) clearInterval(idleTimer); } catch {}
    try { sub.removeListener('message', onMessage); } catch {}
    try { sub.removeListener('error', onError); } catch {}
    try { for (const iv of sessionTimers.values()) clearInterval(iv); } catch {}
    sessionTimers.clear();
    // Fire-and-forget final sync attempts similar to stream route shutdown
    try {
      for (const [sid, st] of sessionState.entries()) {
        if (st?.gcs?.token) {
          try { syncBucketPrefix({ bucket: st.gcs.bucket, prefix: st.gcs.prefix, workRoot: st.workRoot, token: st.gcs.token }); } catch {}
        }
      }
    } catch {}
    sessionState.clear();
    try { await sub.close(); } catch {}
    try { await pubsub.close(); } catch {}
    process.exit(0);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[consumer] fatal startup error', err?.message || err);
  process.exit(1);
});
