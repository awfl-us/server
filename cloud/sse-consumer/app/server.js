import express from 'express';
import axios from 'axios';
import { createParser } from 'eventsource-parser';
import { GoogleAuth } from 'google-auth-library';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';

// Env helpers
const PORT = process.env.PORT || 8080;
const SERVICE_AUTH_TOKEN = process.env.SERVICE_AUTH_TOKEN || '';
const WORK_ROOT = path.resolve(process.env.WORK_ROOT || '/mnt/work');
const WORKFLOWS_BASE_URL = process.env.WORKFLOWS_BASE_URL || '';
const WORKFLOWS_AUDIENCE = process.env.WORKFLOWS_AUDIENCE || WORKFLOWS_BASE_URL;
const EVENTS_HEARTBEAT_MS = Number(process.env.EVENTS_HEARTBEAT_MS || 15000);
const RECONNECT_BACKOFF_MS = Number(process.env.RECONNECT_BACKOFF_MS || 1000);
const RUN_COMMAND_TIMEOUT_SECONDS = Number(process.env.RUN_COMMAND_TIMEOUT_SECONDS || 120);
const READ_FILE_MAX_BYTES = Number(process.env.READ_FILE_MAX_BYTES || 200000);
const OUTPUT_MAX_BYTES = Number(process.env.OUTPUT_MAX_BYTES || 50000);

const app = express();

// Basic liveness
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// Auth middleware for inbound requests (dev-only bearer). Prefer IAM in production.
function checkInboundAuth(req, res) {
  if (!SERVICE_AUTH_TOKEN) return true; // local/dev
  const authz = req.headers['authorization'] || '';
  const expected = `Bearer ${SERVICE_AUTH_TOKEN}`;
  if (authz !== expected) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

// Utility: ensure path is within WORK_ROOT
function resolveWithinWorkRoot(rel) {
  const target = path.resolve(WORK_ROOT, rel);
  if (!target.startsWith(WORK_ROOT + path.sep) && target !== WORK_ROOT) {
    throw new Error('Path escapes WORK_ROOT');
  }
  return target;
}

// Tool handlers
async function handleUpdateFile(args) {
  if (!args || typeof args.filepath !== 'string') throw new Error('UPDATE_FILE: missing filepath');
  const content = typeof args.content === 'string' ? args.content : '';
  const abs = resolveWithinWorkRoot(args.filepath);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf8');
  const st = await fsp.stat(abs);
  return { ok: true, filepath: args.filepath, bytes: Buffer.byteLength(content, 'utf8'), mtimeMs: st.mtimeMs };
}

async function readFirstNBytes(absPath, n) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const stream = fs.createReadStream(absPath, { encoding: 'utf8' });
    stream.on('data', (chunk) => {
      const remaining = n - total;
      if (chunk.length <= remaining) {
        chunks.push(chunk);
        total += chunk.length;
      } else {
        chunks.push(chunk.slice(0, remaining));
        total += remaining;
        stream.destroy();
      }
    });
    stream.on('close', () => resolve(chunks.join('')));
    stream.on('error', (err) => reject(err));
  });
}

async function handleReadFile(args) {
  if (!args || typeof args.filepath !== 'string') throw new Error('READ_FILE: missing filepath');
  const abs = resolveWithinWorkRoot(args.filepath);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isFile()) throw new Error('READ_FILE: not found or not a file');
  let content = '';
  let truncated = false;
  if (st.size > READ_FILE_MAX_BYTES) {
    content = await readFirstNBytes(abs, READ_FILE_MAX_BYTES);
    truncated = true;
  } else {
    content = await fsp.readFile(abs, 'utf8');
  }
  return { ok: true, filepath: args.filepath, content, truncated };
}

function execCommand(command) {
  return new Promise((resolve) => {
    const timeoutMs = RUN_COMMAND_TIMEOUT_SECONDS * 1000;
    exec(command, { cwd: WORK_ROOT, timeout: timeoutMs, maxBuffer: OUTPUT_MAX_BYTES }, (error, stdout, stderr) => {
      const result = {
        ok: !error,
        exitCode: typeof error?.code === 'number' ? error.code : 0,
        stdout,
        stderr,
        timed_out: (error && (error.killed || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT')) || false,
      };
      // Detect truncation heuristically
      if (stdout && Buffer.byteLength(stdout) >= OUTPUT_MAX_BYTES) result.truncated = true;
      if (stderr && Buffer.byteLength(stderr) >= OUTPUT_MAX_BYTES) result.truncated = true;
      resolve(result);
    });
  });
}

async function handleRunCommand(args) {
  if (!args || typeof args.command !== 'string') throw new Error('RUN_COMMAND: missing command');
  // Execute via bash -lc for simple shell semantics
  const command = `bash -lc ${JSON.stringify(args.command)}`;
  const res = await execCommand(command);
  return res;
}

// IAM ID token helper for calling workflows service
const auth = new GoogleAuth();
async function getIdTokenHeader(audience) {
  const aud = audience || WORKFLOWS_AUDIENCE || WORKFLOWS_BASE_URL;
  try {
    const client = await auth.getIdTokenClient(aud);
    const headers = await client.getRequestHeaders(aud);
    return headers; // includes Authorization: Bearer <token>
  } catch (err) {
    // Fallback for local dev where IAM may be unavailable
    return {};
  }
}

async function postCallback({ callbackId, payload, contextHeaders }) {
  if (!WORKFLOWS_BASE_URL) throw new Error('WORKFLOWS_BASE_URL not set');
  const url = `${WORKFLOWS_BASE_URL.replace(/\/$/, '')}/workflows/callbacks/${encodeURIComponent(callbackId)}`;
  const authzHeaders = await getIdTokenHeader(WORKFLOWS_AUDIENCE);
  const headers = {
    ...authzHeaders,
    'Content-Type': 'application/json',
    ...contextHeaders,
  };
  const maxAttempts = 3;
  let attempt = 0;
  let lastErr;
  while (attempt < maxAttempts) {
    attempt++;
    try {
      await axios.post(url, payload, { headers, timeout: 15000 });
      return;
    } catch (err) {
      lastErr = err;
      const base = 300 * attempt;
      const jitter = Math.floor(Math.random() * 200);
      await new Promise((r) => setTimeout(r, base + jitter));
    }
  }
  throw lastErr || new Error('Callback failed');
}

function toJSONSafe(val) {
  try { return JSON.parse(val); } catch { return null; }
}

function parseToolArgs(maybe) {
  if (maybe == null) return {};
  if (typeof maybe === 'string') {
    const parsed = toJSONSafe(maybe);
    return parsed && typeof parsed === 'object' ? parsed : { raw: maybe };
  }
  if (typeof maybe === 'object') return maybe;
  return { value: maybe };
}

// SSE consumer loop
function startConsumer({ userId, projectId, workspaceId, sessionId, since_id, since_time, res }) {
  let aborted = false;
  let lastEventId = undefined;
  let reconnectDelay = RECONNECT_BACKOFF_MS;
  const reconnectCap = 30000;
  let upstreamIdleTimer = null;
  const upstreamIdleMs = Math.max(EVENTS_HEARTBEAT_MS * 2, 60000);

  const contextHeaders = {
    'X-User-Id': userId,
    'X-Project-Id': projectId,
    ...(workspaceId ? { 'X-Workspace-Id': workspaceId } : {}),
  };

  async function connect(initial = false) {
    if (aborted) return;
    const params = new URLSearchParams();
    if (workspaceId) params.set('workspaceId', workspaceId);
    else if (projectId) params.set('projectId', projectId);
    if (since_id || lastEventId) params.set('since_id', (lastEventId || since_id));
    else if (since_time) params.set('since_time', since_time);

    const url = `${WORKFLOWS_BASE_URL.replace(/\/$/, '')}/workflows/events/stream?${params.toString()}`;
    const authzHeaders = await getIdTokenHeader(WORKFLOWS_AUDIENCE);

    res.write(`ping ${Date.now()}\n`);

    let cancelSource = axios.CancelToken.source();

    const resetUpstreamIdle = () => {
      if (upstreamIdleTimer) clearTimeout(upstreamIdleTimer);
      upstreamIdleTimer = setTimeout(() => {
        // upstream idle; reconnect
        try { cancelSource.cancel('upstream idle'); } catch {}
      }, upstreamIdleMs);
    };

    resetUpstreamIdle();

    const parser = createParser((event) => {
      if (event.type === 'event' || event.type === 'message') {
        resetUpstreamIdle();
        if (event.id) lastEventId = event.id;
        const dataStr = event.data;
        if (!dataStr) return;
        let data;
        try {
          data = JSON.parse(dataStr);
        } catch {
          return; // ignore malformed JSON
        }
        handleEvent(data).catch((err) => {
          // We do not crash the consumer; log to client stream for observability
          try { res.write(`error ${Date.now()} ${JSON.stringify({ message: err.message })}\n`); } catch {}
        });
      }
    });

    try {
      const response = await axios.get(url, {
        headers: {
          Accept: 'text/event-stream',
          ...authzHeaders,
          ...contextHeaders,
        },
        responseType: 'stream',
        timeout: 0, // no timeout; rely on idle watchdog
        cancelToken: cancelSource.token,
        decompress: true,
        transitional: { clarifyTimeoutError: true },
      });

      response.data.on('data', (chunk) => {
        parser.feed(chunk.toString());
      });
      response.data.on('end', () => {
        if (aborted) return;
        scheduleReconnect('end');
      });
      response.data.on('error', () => {
        if (aborted) return;
        scheduleReconnect('error');
      });
    } catch (err) {
      if (aborted) return;
      scheduleReconnect(err?.message || 'connect error');
    }

    function scheduleReconnect(reason) {
      if (upstreamIdleTimer) { clearTimeout(upstreamIdleTimer); upstreamIdleTimer = null; }
      const jitter = Math.floor(Math.random() * 250);
      const delay = Math.min(reconnectDelay + jitter, reconnectCap);
      try { res.write(`reconnect ${Date.now()} ${reason}\n`); } catch {}
      setTimeout(() => connect(false), delay);
      reconnectDelay = Math.min(reconnectDelay * 2, reconnectCap);
    }
  }

  async function handleEvent(evt) {
    const now = new Date().toISOString();
    const tool = evt?.tool_call?.function?.name;
    const args = parseToolArgs(evt?.tool_call?.function?.arguments);

    if (!tool) return; // ignore non tool events
    let result = null;
    let error = null;

    try {
      switch (tool) {
        case 'UPDATE_FILE':
          result = await handleUpdateFile(args);
          break;
        case 'READ_FILE':
          result = await handleReadFile(args);
          break;
        case 'RUN_COMMAND':
          result = await handleRunCommand(args);
          break;
        default:
          throw new Error(`Unsupported tool: ${tool}`);
      }
    } catch (err) {
      error = { message: err?.message || String(err) };
    }

    if (evt?.callback_id) {
      const payload = {
        event_id: evt.id || undefined,
        create_time: evt.create_time || undefined,
        tool: { name: tool },
        args,
        result,
        error,
        timestamp: now,
      };
      try {
        await postCallback({ callbackId: evt.callback_id, payload, contextHeaders });
      } catch (err) {
        // surface callback failure to client stream
        try { res.write(`callback_error ${Date.now()} ${JSON.stringify({ message: err.message })}\n`); } catch {}
      }
    }
  }

  // Heartbeat to client to keep the HTTP connection open
  const hb = setInterval(() => {
    if (aborted) return;
    try { res.write(`ping ${Date.now()}\n`); } catch {}
  }, EVENTS_HEARTBEAT_MS);

  // Client closed
  res.on('close', () => {
    aborted = true;
    if (upstreamIdleTimer) clearTimeout(upstreamIdleTimer);
    clearInterval(hb);
  });

  // kick off initial connect
  connect(true).catch(() => {});
}

app.get('/sessions/consume', async (req, res) => {
  if (!checkInboundAuth(req, res)) return;
  const userId = String(req.query.userId || '');
  const projectId = String(req.query.projectId || '');
  const workspaceId = req.query.workspaceId ? String(req.query.workspaceId) : '';
  const sessionId = req.query.sessionId ? String(req.query.sessionId) : '';
  const since_id = req.query.since_id ? String(req.query.since_id) : '';
  const since_time = req.query.since_time ? String(req.query.since_time) : '';

  if (!userId || !projectId) {
    return res.status(400).json({ error: 'userId and projectId are required' });
  }
  if (!WORKFLOWS_BASE_URL) {
    return res.status(500).json({ error: 'WORKFLOWS_BASE_URL not configured' });
  }

  // Check WORK_ROOT availability
  try {
    await fsp.mkdir(WORK_ROOT, { recursive: true });
    await fsp.access(WORK_ROOT, fs.constants.W_OK | fs.constants.R_OK);
  } catch (err) {
    return res.status(500).json({ error: 'WORK_ROOT not accessible', details: err?.message });
  }

  // Long-lived response
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');

  res.write(`starting ${Date.now()}\n`);

  startConsumer({ userId, projectId, workspaceId, sessionId, since_id, since_time, res });
});

app.listen(PORT, () => {
  console.log(`sse-consumer listening on :${PORT}`);
});
