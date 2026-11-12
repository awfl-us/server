/** Public AWFL MCP guidance and secret-free consumer inventory contract. */
export const ENVIRONMENT_GUIDE_URI = 'awfl://environment/guide';

export const ENVIRONMENT_INSTRUCTIONS = [
  'AWFL attaches to one existing project-scoped shared GKE consumer, not a separate execution backend.',
  'Call image_profiles_list to discover available images. Call projects_list, workspace_create({project_id}), and then environment_status({workspace_id}) to discover readiness, credentials and tools.',
  'New consumers require an explicit image_profile: lightweight, browser (Chromium/Playwright), or scala (Java/sbt/Rust and 4Gi ephemeral storage). Attaching to an existing shared consumer may omit it; switching the image requires first stopping the consumer.',
  'Environment details come from the current consumer heartbeat. Missing or stale heartbeat means unknown, not credentials absent.',
  'Google Cloud normally uses CLOUDSDK_AUTH_ACCESS_TOKEN_FILE (/tmp/awfl-google-access-token) and CLOUDSDK_CORE_PROJECT. Do not print token contents.',
  'GitHub normally uses AWFL_GITHUB_TOKEN_FILE (/tmp/awfl-github-token) with a Git credential helper. New CLI subprocesses load the latest token.',
  'AWFL API keys are separate from GCP/GitHub credentials. They authenticate the Workflows API and both MCP endpoints. Manage them in AWFL Settings > API Keys.',
  'Never echo, log or share secret token values. More details: MCP resource awfl://environment/guide.',
].join('\n');

export const ENVIRONMENT_GUIDE = [
  '# AWFL cloud environment guide',
  '',
  'AWFL MCP uses the **existing shared project-scoped GKE Python consumer**, Firestore execution records and consumer lock. It does not create an independent runtime.',
  '',
  '## Discover the environment',
  '',
  '1. Call projects_list, workspace_create({project_id}), then environment_status({workspace_id}).',
  '   Starting a new consumer requires image_profile: "scala" (Java 21/sbt, Rust, 4Gi), "lightweight" (1Gi) or "browser" (Chromium/Playwright, 2Gi). Existing running consumers can be attached without choosing an image. Image changes require stopping the existing project consumer first.',
  '2. Consumer readiness is not the same as an active Kubernetes Job; wait until the consumer heartbeat says ready.',
  '3. The environment object reflects the latest fresh consumer heartbeat, not the MCP server process. Null means unknown/not ready, not missing credentials.',
  '4. Use run_command and command_output for shell execution, read_file and apply_patch for edits, and search_files/list_directory for inspection.',
  '',
  '## Google Cloud',
  '',
  '- CLOUDSDK_AUTH_ACCESS_TOKEN_FILE normally identifies /tmp/awfl-google-access-token (secret content).',
  '- CLOUDSDK_CORE_PROJECT identifies the configured GCP project. gcloud is normally installed at /opt/google-cloud-sdk/bin/gcloud.',
  '- Use gcloud or read the token file inside a trusted process only; never print the token or include it in command output or logs.',
  '- Refresh is configured when available. A reported token file is not proof of live authorization or IAM permissions.',
  '',
  '## GitHub',
  '',
  '- AWFL_GITHUB_TOKEN_FILE normally identifies /tmp/awfl-github-token (secret content).',
  '- Git uses a dynamic credential helper; prefer normal git commands without displaying credentials.',
  '- New Python consumer subprocesses load fresh GITHUB_TOKEN and GH_TOKEN from the rotated file when present. Already-running shells can retain stale environment values.',
  '',
  '## AWFL API keys are different',
  '',
  '- AWFL API keys authorize calls to https://api.awfl.us/workflows, /mcp and /mcp/agents. They are not Google Cloud or GitHub tokens.',
  '- Create and revoke AWFL keys from AWFL web Settings > API Keys.',
  '- Management endpoints require an authenticated AWFL user (Firebase ID token, AWFL OAuth token, or AWFL API key); GCP access tokens are not accepted:',
  '  GET /workflows/api-keys — list metadata;',
  '  POST /workflows/api-keys with JSON {"name":"My AWFL client"} — return a new key ONCE;',
  '  DELETE /workflows/api-keys/:id — revoke.',
  '- Use an authenticated key-management flow. Never expose the newly generated key in agent tool output, logs or conversation.',
  '',
  '## Security and interpretation',
  '',
  '- Environment status contains only allowlisted booleans, known variable names, documented token paths and the configured GCP project. No credential values.',
  '- A nonempty token file indicates configured local credentials; it does not confirm OAuth validity or cloud IAM authorization.',
  '- Workspaces and executions remain scoped to project authorization. Shared consumer process state must not be changed globally.',
].join('\n');

const TOOL_NAMES = ['git', 'gcloud', 'python', 'node', 'chromium_playwright', 'java', 'sbt'];
const GOOGLE_PATH = '/tmp/awfl-google-access-token';
const GITHUB_PATH = '/tmp/awfl-github-token';

/** Reject arbitrary fields before persisting heartbeat data in Firestore. */
export function sanitizeEnvironment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const credentials = value.credentials || {};
  const google = credentials.google_cloud || {};
  const github = credentials.github || {};
  const tools = value.tools || {};
  const project = google.project;
  const cwd = typeof value.cwd === 'string' &&
    value.cwd.startsWith('/') && value.cwd.length <= 1024 &&
    !/[\u0000-\u001f\u007f]/.test(value.cwd) ? value.cwd : null;
  return {
    runtime: 'shared_gke_python_consumer',
    cwd,
    credentials: {
      google_cloud: {
        available: google.available === true,
        token_file_env: 'CLOUDSDK_AUTH_ACCESS_TOKEN_FILE',
        token_file: google.token_file === GOOGLE_PATH && google.available === true ? GOOGLE_PATH : null,
        project_env: 'CLOUDSDK_CORE_PROJECT',
        project: typeof project === 'string' && /^[a-z][a-z0-9-]{0,62}$/.test(project) ? project : null,
        refresh_configured: google.refresh_configured === true,
        cli_available: google.cli_available === true,
      },
      github: {
        available: github.available === true,
        token_file_env: 'AWFL_GITHUB_TOKEN_FILE',
        token_file: github.token_file === GITHUB_PATH && github.available === true ? GITHUB_PATH : null,
        refresh_configured: github.refresh_configured === true,
        git_credential_helper: github.git_credential_helper === true,
        cli_available: github.cli_available === true,
      },
    },
    tools: Object.fromEntries(TOOL_NAMES.map(name => [name, tools[name] === true])),
  };
}
