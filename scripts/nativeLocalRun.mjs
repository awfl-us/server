#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runLocalProjectManager, completedProjectManagerTwoTurnLoop } from './nativeLocalDev.mjs';

function arg(name) {
  const pos = process.argv.indexOf(name);
  return pos >= 0 ? process.argv[pos + 1] : null;
}
const report = arg('--report') || process.env.AWFL_NATIVE_LOCAL_BUILD_REPORT;
const inputFile = arg('--input') || process.env.AWFL_NATIVE_LOCAL_INPUT;
const fixturesFile = arg('--fixtures') || process.env.AWFL_NATIVE_LOCAL_FIXTURES;
const localJobsUrl = arg('--local-jobs-url');
const waitDetached = process.argv.includes('--wait-detached');
const requirePmLoop = process.argv.includes('--require-pm-loop');
if (requirePmLoop && (!waitDetached || !localJobsUrl)) {
  console.error('--require-pm-loop requires --wait-detached and --local-jobs-url');
  process.exit(2);
}
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
  tokenFile, localJobsUrl,
  waitDetached,
});
if (waitDetached) {
  console.log('AWFL_NATIVE_LOCAL_ASYNC_SUMMARY ' + JSON.stringify({
    executionId: result.executionId, rootStatus:result.status,
    rootToolCalls:result.result?.message?.tool_calls?.length || 0,
    durationMs:result.durationMs, detachedLaunches:result.detachedLaunches,
    failedRequests:result.failedRequests.length,
    missingEffects:result.missing.length,
    strictPmLoopPassed: completedProjectManagerTwoTurnLoop(result),
  }));
}
console.log('AWFL_NATIVE_LOCAL_RESULT ' + JSON.stringify(result).slice(0, 12000));
if (result.error || result.missing.length || result.status !== 'completed' ||
    (requirePmLoop && !completedProjectManagerTwoTurnLoop(result))) {
  if (requirePmLoop && !completedProjectManagerTwoTurnLoop(result)) {
    console.error('AWFL_NATIVE_PM_LOOP_INCOMPLETE ' +
      JSON.stringify(result.detachedLaunches || []));
  }
  process.exitCode = 1;
}
