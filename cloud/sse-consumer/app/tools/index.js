import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
  READ_FILE_MAX_BYTES,
  OUTPUT_MAX_BYTES,
  RUN_COMMAND_TIMEOUT_SECONDS,
} from '../config.js';

const execAsync = promisify(exec);

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function ensureString(val) {
  return typeof val === 'string' ? val : String(val ?? '');
}

function limitOutput(s, limit = OUTPUT_MAX_BYTES) {
  const buf = Buffer.isBuffer(s) ? s : Buffer.from(String(s || ''), 'utf8');
  if (buf.byteLength <= limit) return buf.toString('utf8');
  const head = buf.subarray(0, Math.floor(limit * 0.6)).toString('utf8');
  const tail = buf.subarray(buf.byteLength - Math.floor(limit * 0.3)).toString('utf8');
  return `${head}\n... [${buf.byteLength - head.length - tail.length} bytes truncated] ...\n${tail}`;
}

export async function doReadFile(args, resolvePath) {
  const rel = ensureString(args.filepath || args.path || args.file || args.target);
  if (!rel) throw new Error('READ_FILE: missing filepath');
  const abs = resolvePath(rel);
  const stat = await fsp.stat(abs);
  if (!stat.isFile()) throw new Error('READ_FILE: not a file');
  if (stat.size > READ_FILE_MAX_BYTES) {
    const fd = await fsp.open(abs, 'r');
    try {
      const buf = Buffer.alloc(READ_FILE_MAX_BYTES);
      const { bytesRead } = await fd.read(buf, 0, READ_FILE_MAX_BYTES, 0);
      const content = buf.subarray(0, bytesRead).toString('utf8');
      return { filepath: path.relative(process.cwd(), abs), content, truncated: true, bytes: stat.size };
    } finally {
      await fd.close();
    }
  }
  const content = await fsp.readFile(abs, 'utf8');
  return { filepath: path.relative(process.cwd(), abs), content, truncated: false, bytes: stat.size };
}

export async function doUpdateFile(args, resolvePath) {
  const rel = ensureString(args.filepath || args.path || args.file || args.target);
  if (!rel) throw new Error('UPDATE_FILE: missing filepath');
  const abs = resolvePath(rel);
  const content = ensureString(args.content ?? args.data ?? '');
  const append = Boolean(args.append);
  const mkdirp = args.mkdirp !== false; // default true
  if (mkdirp) await fsp.mkdir(path.dirname(abs), { recursive: true });
  if (append) {
    await fsp.appendFile(abs, content, 'utf8');
  } else {
    await fsp.writeFile(abs, content, 'utf8');
  }
  const bytesWritten = Buffer.byteLength(content, 'utf8');
  return { filepath: rel, bytesWritten, append };
}

export async function doRunCommand(args, cwd) {
  const cmd = ensureString(args.command || args.cmd || args.run || args.shell);
  if (!cmd) throw new Error('RUN_COMMAND: missing command');
  const timeoutMs = clamp(Number(args.timeoutSeconds ?? RUN_COMMAND_TIMEOUT_SECONDS) * 1000, 1000, 10 * 60 * 1000);
  const env = { ...process.env };
  const opts = { cwd: cwd || process.cwd(), timeout: timeoutMs, maxBuffer: Math.max(OUTPUT_MAX_BYTES * 4, 1_000_000), env };
  try {
    const { stdout, stderr } = await execAsync(cmd, opts);
    return {
      command: cmd,
      output: limitOutput(stdout),
      error: limitOutput(stderr),
      exitCode: 0,
      timeoutMs,
    };
  } catch (err) {
    // exec throws on non-zero exit; include partial outputs
    return {
      command: cmd,
      output: limitOutput(err?.stdout || ''),
      error: limitOutput(err?.stderr || String(err?.message || '')),
      exitCode: typeof err?.code === 'number' ? err.code : 1,
      timeoutMs,
    };
  }
}
