#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runLocalProjectManager } from './nativeLocalDev.mjs';

function arg(name) {
  const pos = process.argv.indexOf(name);
  return pos >= 0 ? process.argv[pos + 1] : null;
}
const report = arg('--report') || process.env.AWFL_NATIVE_LOCAL_BUILD_REPORT;
const inputFile = arg('--input') || process.env.AWFL_NATIVE_LOCAL_INPUT;
const fixturesFile = arg('--fixtures') || process.env.AWFL_NATIVE_LOCAL_FIXTURES;
const localJobsUrl = arg('--local-jobs-url');
const executionMode = process.argv.includes('--memory') ? 'memory' : 'durable';
if (!report || !inputFile || (!fixturesFile && !localJobsUrl)) {
  console.error('Usage: node scripts/nativeLocalRun.mjs --report <build-report.json> ' +
    '--input <projectmanager-input.json> --fixtures <recorded-http.json> [--live-storage]');
  process.exit(2);
}
const input = JSON.parse(await readFile(resolve(inputFile), 'utf8'));
const fixtures = fixturesFile ? JSON.parse(await readFile(resolve(fixturesFile), 'utf8')) : {};
const tokenFile = process.argv.includes('--live-storage')
  ? process.env.CLOUDSDK_AUTH_ACCESS_TOKEN_FILE : null;
// The existing GKE Scala consumer exposes the GCP project under CLOUDSDK.
process.env.GCP_PROJECT ||= process.env.CLOUDSDK_CORE_PROJECT;
const result = await runLocalProjectManager({
  reportPath: resolve(report), input, fixtures,
  identity: {
    userId: process.env.AWFL_USER_ID,
    projectId: process.env.AWFL_PROJECT_ID,
  },
  tokenFile, localJobsUrl, executionMode,
});
console.log('AWFL_NATIVE_LOCAL_RESULT ' + JSON.stringify(result).slice(0, 12000));
if (result.error || result.missing.length || result.status !== 'completed') {
  process.exitCode = 1;
}
