import { runLocalDocker } from './docker.js';
import { splitArgs, applyTemplate } from './utils.js';
import { buildLocalConsumerEnv } from './envBuilder.js';

export async function launchLocalPair({
  producerImage,
  producerContainerName,
  producerEnvPairs,
  producerExtraArgs,
  // Consumer (repurposed sidecar) as local Pub/Sub worker
  consumerImage,
  consumerContainerName,
  consumerArgsTemplate,
  workflowsBaseUrl,
  eventsHeartbeatMs,
  reconnectBackoffMs,
  encKeyB64,
  encVer,
  topic,
  subReq,
  // Context
  projectId,
  // Optional: GitHub token passthrough
  githubToken,
  // Optional: per-request Firebase auth tokens for the caller
  firebaseIdToken,
  firebaseCustomToken,
}) {
  let consumerInfo = null;
  // Default startup script for the consumer
  const defaultStartup = 'set -e; '
    + 'python -m pip install --user awfl && "$HOME/.local/bin/awfl" run';
  const startupSh = process.env.AWFL_STARTUP_SH || defaultStartup;

  if (consumerImage && consumerContainerName) {
    const renderedArgs = applyTemplate(consumerArgsTemplate || '', {});
    const consumerExtraArgs = [
      '--label', 'awfl.role=sse-consumer-sidecar',
      ...(consumerContainerName ? ['--label', `awfl.container=${consumerContainerName}`] : []),
      ...splitArgs(renderedArgs),
    ];

    const consumerEnv = buildLocalConsumerEnv({
      workflowsBaseUrl,
      eventsHeartbeatMs,
      reconnectBackoffMs,
      encKeyB64,
      encVer,
      topic,
      subReq,
      projectId,
      consumerType: 'CLOUD',
    });

    // Auth/env overrides for the consumer-only container
    // - Prefer writing ~/.awfl/tokens.json via AWFL_TOKENS_JSON_B64 or AWFL_TOKENS_JSON
    // - Pass per-request FIREBASE_ID_TOKEN if provided; otherwise pass FIREBASE_CUSTOM_TOKEN if provided
    // - Also allow SKIP_AUTH passthrough from process env for local dev
    const authEnvPairs = [];
    if (firebaseIdToken) authEnvPairs.push({ name: 'FIREBASE_ID_TOKEN', value: String(firebaseIdToken) });
    else if (firebaseCustomToken) authEnvPairs.push({ name: 'FIREBASE_CUSTOM_TOKEN', value: String(firebaseCustomToken) });
    if (process.env.SKIP_AUTH) authEnvPairs.push({ name: 'SKIP_AUTH', value: String(process.env.SKIP_AUTH) });
    if (process.env.AWFL_TOKENS_JSON_B64) authEnvPairs.push({ name: 'AWFL_TOKENS_JSON_B64', value: String(process.env.AWFL_TOKENS_JSON_B64) });
    if (process.env.AWFL_TOKENS_JSON) authEnvPairs.push({ name: 'AWFL_TOKENS_JSON', value: String(process.env.AWFL_TOKENS_JSON) });
    consumerEnv.push(...authEnvPairs);

    // Pass through GitHub token if available (do not log)
    if (githubToken) consumerEnv.push({ name: 'GITHUB_TOKEN', value: String(githubToken) });

    consumerInfo = await runLocalDocker({
      image: consumerImage,
      containerName: consumerContainerName,
      envPairs: consumerEnv,
      extraArgs: consumerExtraArgs,
      // Only the consumer uses the unified startup script override
      shCommand: startupSh,
    });
  }

  // Producer must run with its image's default entrypoint/cmd (no startup script override)
  const producerInfo = await runLocalDocker({
    image: producerImage || 'awfl-producer:dev',
    containerName: producerContainerName,
    envPairs: producerEnvPairs,
    extraArgs: Array.isArray(producerExtraArgs) ? producerExtraArgs : splitArgs(producerExtraArgs || ''),
  });

  return { producerInfo, consumerInfo };
}
