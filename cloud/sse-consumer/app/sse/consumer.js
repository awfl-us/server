import path from 'path';
import { WORKFLOWS_BASE_URL, EVENTS_HEARTBEAT_MS } from '../config.js';
import { getIdTokenHeader } from '../auth.js';
import { resolveWithin } from '../storage.js';
import { parseToolArgs } from '../utils/parse.js';
import { doReadFile, doRunCommand, doUpdateFile } from '../tools/index.js';
import { syncBucketPrefix } from '../gcs-sync.js';

const CONSUMER_TRACE = /^1|true|yes$/i.test(String(process.env.CONSUMER_TRACE || '1'));
function ctr(...args) { if (CONSUMER_TRACE) console.log('[consumer][cb]', ...args); }

function isCallbackEvent(obj) {
  if (!obj) return false;
  // Accept multiple shapes:
  // - { type: 'callback' | 'tool', ... }
  // - { tool: 'READ_FILE', args: {...} }
  // - { tool_call: { function: { name, arguments } }, ... }
  const t = obj?.type || obj?.event || obj?.kind;
  if (t && (String(t).toLowerCase() === 'callback' || String(t).toLowerCase() === 'tool')) return true;
  if (typeof obj?.tool === 'string' && obj.tool) return true;
  if (obj && obj.tool_call && obj.tool_call.function && obj.tool_call.function.name) return true;
  return false;
}

function getToolName(obj) {
  if (obj?.tool_call?.function?.name) return obj.tool_call.function.name;
  return obj?.tool || obj?.name || obj?.callback || obj?.command || obj?.action || obj?.type;
}

function getToolArgs(obj) {
  if (obj?.tool_call?.function) return obj.tool_call.function.arguments;
  return obj?.args ?? obj?.arguments ?? obj?.payload?.args ?? obj?.payload;
}

export function createHandlers({ workRoot, res, gcs, sessionId }) {
  async function handleCallback(ev) {
    const id = ev?.id || ev?.event_id || ev?.request_id || null;
    const callbackId = ev?.callbackId || ev?.callback_id || null;
    const tool = String(getToolName(ev) || '').toUpperCase();
    const argsRaw = getToolArgs(ev);
    const args = parseToolArgs(argsRaw);

    // Determine active root: allow explicit directory override via ev.workdir
    let activeRoot = workRoot;
    try {
      const wd = ev?.workdir;
      if (wd && typeof wd === 'string' && wd.trim()) {
        activeRoot = path.isAbsolute(wd) ? wd : path.resolve(workRoot, wd);
      }
    } catch (_) {
      // Ignore malformed workdir; fall back to default workRoot
    }

    const resolvePath = (rel) => resolveWithin(activeRoot, rel);

    ctr('tool start', { id, tool, hasCallback: Boolean(callbackId), usingWorkdir: activeRoot !== workRoot, activeRoot });

    try {
      let result;
      if (tool === 'READ_FILE') {
        result = await doReadFile(args, resolvePath);
      } else if (tool === 'UPDATE_FILE') {
        result = await doUpdateFile(args, resolvePath);
      } else if (tool === 'RUN_COMMAND') {
        // Support top-level timeout_seconds on the event object. null => unlimited
        let runArgs = args;
        if (Object.prototype.hasOwnProperty.call(ev || {}, 'timeout_seconds')) {
          const t = ev.timeout_seconds;
          runArgs = { ...args, timeoutSeconds: t === null ? null : Number(t) };
        }
        result = await doRunCommand(runArgs, activeRoot);
      } else if (tool === 'GCS_SYNC' || tool === 'SYNC_GCS' || tool === 'GCS.MIRROR') {
        const bucket = String(args.bucket || gcs?.bucket || '');
        const prefix = String(args.prefix || gcs?.prefix || '');
        const token = String(args.token || gcs?.token || '');
        if (!bucket) throw new Error('GCS_SYNC: missing bucket');
        result = await syncBucketPrefix({ bucket, prefix, workRoot: activeRoot, token });
      } else {
        // Unknown callback — return null as result per minimization contract
        result = null;
      }
      const payload = id ? { id, result } : { result };
      try { res.write(`${JSON.stringify(payload)}\n`); } catch {}
      ctr('tool done', { id, tool, ok: true });
    } catch (err) {
      const payload = id ? { id, result: null, error: String(err?.message || err || 'tool_error') } : { result: null, error: String(err?.message || err || 'tool_error') };
      try { res.write(`${JSON.stringify(payload)}\n`); } catch {}
      ctr('tool done', { id, tool, ok: false, error: String(err?.message || err) });
    }
  }

  async function handleEventObject(obj) {
    if (obj == null) return;
    if (isCallbackEvent(obj)) return handleCallback(obj);
    // Non-callback events are ignored — only tool results are emitted to the response stream
    return;
  }

  async function handleLine(line) {
    const t = String(line || '').trim();
    if (!t) return;
    try {
      const obj = JSON.parse(t);
      await handleEventObject(obj);
    } catch {
      // Ignore non-JSON (protocol heartbeats or noise)
    }
  }

  return { handleLine, handleEventObject };
}

export async function startConsumer({ userId, projectId, workspaceId, sessionId, since_id, since_time, res, workRoot }) {
  // Initial ready + heartbeat pings
  try { res.write(`ready ${Date.now()}\n`); } catch {}
  const pingIv = setInterval(() => {
    try { res.write(`ping ${Date.now()}\n`); } catch {}
  }, EVENTS_HEARTBEAT_MS);

  const { handleLine } = createHandlers({ workRoot, res, sessionId });

  try {
    const url = new URL(`${WORKFLOWS_BASE_URL.replace(/\/$/, '')}/events/stream`);
    if (userId) url.searchParams.set('userId', String(userId));
    if (projectId) url.searchParams.set('projectId', String(projectId));
    if (workspaceId) url.searchParams.set('workspaceId', String(workspaceId));
    if (sessionId) url.searchParams.set('sessionId', String(sessionId));
    if (since_id) url.searchParams.set('since_id', String(since_id));
    if (since_time) url.searchParams.set('since_time', String(since_time));

    const headers = await getIdTokenHeader(url.origin);
    const resp = await fetch(url, { headers });
    if (!resp.ok || !resp.body) {
      try { res.write(`error ${Date.now()} ${JSON.stringify({ status: resp.status })}\n`); } catch {}
      clearInterval(pingIv);
      res.end();
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // Pump chunks and split by newline (NDJSON)
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        await handleLine(line);
      }
    }
    if (buffer.trim()) await handleLine(buffer);
  } catch (err) {
    try { res.write(`error ${Date.now()} ${JSON.stringify({ message: err?.message || 'stream_error' })}\n`); } catch {}
  } finally {
    clearInterval(pingIv);
    try { res.end(); } catch {}
  }
}
