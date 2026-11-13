// Trusted ABI-3 native streaming IPC. One authenticated execution owns each
// session; callers never share Rust subprocesses across users or executions.
// Protocol-v2 continuation data remains external and durable in Node/Firestore.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SHA = /^[a-f0-9]{64}$/;
const MAX_INPUT = 1024 * 1024;
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_EXECUTABLE = 64 * 1024 * 1024;
const MAX_STDERR = 4096;

export function createNativeStreamSession({
  executable, sha256, timeoutMs = 30_000, profiler = null,
}) {
  if (typeof executable !== 'string' || !executable.startsWith('/') ||
      !SHA.test(sha256 || '') || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 || timeoutMs > 300_000) {
    throw new Error('invalid trusted native streaming executable');
  }
  let child = null, stage = null, startPromise = null;
  let closed = false, fatalError = null, pending = null;
  let output = Buffer.alloc(0), stderr = '', requestChain = Promise.resolve();
  let spawnCount = 0, requestCount = 0;

  const fail = error => {
    if (fatalError) return;
    fatalError = error instanceof Error ? error :
      new Error('native stream process exited unexpectedly');
    if (pending) {
      const waiter = pending;
      pending = null;
      clearTimeout(waiter.timer);
      waiter.reject(fatalError);
    }
    if (child && !child.killed) child.kill('SIGKILL');
  };

  const start = async () => {
    if (closed) throw new Error('native stream session closed');
    if (fatalError) throw fatalError;
    if (child) return;
    if (!startPromise) startPromise = (async () => {
      const handle = await open(executable, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size < 1 || info.size > MAX_EXECUTABLE) {
          throw new Error('invalid native executable type or size');
        }
        bytes = await handle.readFile();
      } finally { await handle.close(); }
      if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
        throw new Error('artifact SHA-256 mismatch');
      }
      stage = await mkdtemp(join(tmpdir(), 'awfl-native-stream-'));
      const stagedExecutable = join(stage, 'artifact');
      await writeFile(stagedExecutable, bytes, { flag: 'wx', mode: 0o600 });
      await chmod(stagedExecutable, 0o500);
      if (closed) throw new Error('native stream session closed');
      child = spawn(stagedExecutable, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: stage, shell: false,
        env: {
          PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
          AWFL_NATIVE_STREAM_IPC: '1',
        },
      });
      spawnCount++;
      child.on('error', error => fail(error));
      child.on('exit', (code, signal) =>
        fail(new Error('native stream process exited ' +
          (code ?? signal ?? 'unexpectedly') +
          (stderr ? ': ' + stderr : ''))));
      child.stdout.on('data', chunk => {
        output = Buffer.concat([output, chunk]);
        if (output.length > MAX_OUTPUT) {
          fail(new Error('native stream response exceeds limit'));
          return;
        }
        const end = output.indexOf(10);
        if (end === -1) return;
        const line = output.subarray(0, end);
        output = output.subarray(end + 1);
        if (!pending || output.includes(10)) {
          fail(new Error('native stream emitted unexpected response'));
          return;
        }
        const waiter = pending;
        pending = null;
        clearTimeout(waiter.timer);
        try { waiter.resolve(JSON.parse(line.toString('utf8'))); }
        catch { fail(new Error('invalid native stream JSON response')); waiter.reject(fatalError); }
      });
      child.stderr.on('data', chunk => {
        if (stderr.length < MAX_STDERR) {
          stderr += chunk.toString('utf8').slice(0, MAX_STDERR - stderr.length);
        }
      });
    })();
    try {
      await startPromise;
    } catch (error) {
      fail(error);
      throw error;
    }
  };

  async function invoke(input) {
    if (closed) throw new Error('native stream session closed');
    if (fatalError) throw fatalError;
    const payload = JSON.stringify(input);
    if (typeof payload !== 'string' ||
        Buffer.byteLength(payload) + 1 > MAX_INPUT) {
      throw new Error('native stream input exceeds limit');
    }
    const launch = () => start();
    if (profiler) await profiler.measure('rust.stream_start', launch);
    else await launch();
    if (fatalError) throw fatalError;
    if (output.length) throw new Error('native stream has unconsumed output');
    requestCount++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        fail(new Error('native stream request timeout'));
      }, timeoutMs);
      pending = { resolve, reject, timer };
      try {
        child.stdin.write(payload + '\n', error => {
          if (error) fail(error);
        });
      } catch (error) { fail(error); }
    });
  }

  const run = input => {
    const task = requestChain.then(() => {
      const next = () => invoke(input);
      return profiler ? profiler.measure('rust.stream_io', next) : next();
    });
    requestChain = task.catch(() => {});
    return task;
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    if (pending) fail(new Error('native stream session closed'));
    await startPromise?.catch(() => {});
    if (child && child.exitCode === null) {
      // Graceful EOF lets Rust flush diagnostics; bounded wait avoids leaks.
      child.stdin.end();
      await Promise.race([
        new Promise(resolve => child.once('close', resolve)),
        new Promise(resolve => {
          const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 25);
          timer.unref?.();
        }),
      ]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    if (stage) await rm(stage, { recursive: true, force: true });
  };
  return {
    run, close,
    get spawnCount() { return spawnCount; },
    get requestCount() { return requestCount; },
  };
}
