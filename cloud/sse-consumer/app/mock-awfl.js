#!/usr/bin/env node
// Simple mock for awfl: emits JSON lines periodically then exits

const args = process.argv.slice(2);
const durationArg = args.find((a) => a.startsWith('--duration='));
const durationSec = durationArg ? parseInt(durationArg.split('=')[1], 10) : 10;
const intervalArg = args.find((a) => a.startsWith('--interval='));
const intervalMs = intervalArg ? parseInt(intervalArg.split('=')[1], 10) : 500;

let step = 0;
const start = Date.now();

const timer = setInterval(() => {
  step += 1;
  const payload = { type: 'event', step, ts: Date.now(), uptime_ms: Date.now() - start };
  process.stdout.write(JSON.stringify(payload) + '\n');
}, intervalMs);

const shutdown = (sig) => {
  try { clearInterval(timer); } catch {}
  process.stdout.write(`mock-awfl: received ${sig}, shutting down\n`);
  setTimeout(() => process.exit(0), 50);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

setTimeout(() => {
  clearInterval(timer);
  process.stdout.write('mock-awfl: done\n');
  process.exit(0);
}, durationSec * 1000);
