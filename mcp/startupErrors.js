import { randomBytes } from 'node:crypto';

// Only allowlisted validation and startup failures cross the MCP trust boundary.
// Upstream SDK, Firestore and Kubernetes error bodies can contain credentials.
const profileNames = '(lightweight|browser|scala)';
const safeCode = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;

function publicError(code, message, { retryable = false, cause } = {}) {
  const error = new Error(message, { cause });
  error.code = code;
  error.publicMessage = code + ': ' + message;
  error.retryable = retryable;
  return error;
}

export function workspaceStartError(error, { imageProfile } = {}) {
  if (error?.publicMessage) return error;
  const reason = String(error?.message || '');
  const status = error?.statusCode;
  if (reason === 'imageProfile is required when starting a new consumer') {
    return publicError('IMAGE_PROFILE_REQUIRED',
      'A new project consumer requires image_profile. Call image_profiles_list, then workspace_create({project_id: "<id>", image_profile: "lightweight" | "browser" | "scala"}). Only omit image_profile when attaching to an already-running consumer.',
      { cause: error });
  }
  if (reason.startsWith('Unknown image profile:')) {
    return publicError('INVALID_IMAGE_PROFILE',
      'Choose an image_profile from image_profiles_list: lightweight, browser, or scala.',
      { cause: error });
  }
  const conflict = new RegExp('^This project already runs the ' + profileNames + ' image; stop it before choosing ' + profileNames + '$').exec(reason);
  if (conflict) {
    return publicError('IMAGE_PROFILE_CONFLICT',
      'This project already runs the ' + conflict[1] + ' image. Attach with that profile or omit image_profile. Switching to ' + conflict[2] + ' requires stopping the shared consumer first; workspace_stop interrupts other sessions.',
      { cause: error });
  }
  const missing = new RegExp('^The ' + profileNames + ' image is not published/configured \\(CONSUMER_[A-Z0-9_]+\\)$').exec(reason);
  if (missing) {
    return publicError('IMAGE_NOT_CONFIGURED',
      'The ' + missing[1] + ' consumer image is not configured on the server. Choose an available image using image_profiles_list or publish that image before starting a new consumer.',
      { cause: error });
  }
  if (status === 400) {
    return publicError('CONSUMER_CONFIGURATION_REJECTED',
      'The consumer startup configuration was rejected. Check image_profiles_list and specify image_profile when starting a new consumer; see awfl://environment/guide.',
      { cause: error });
  }

  const code = reason === 'Server missing GCP project configuration'
    ? 'SERVER_GCP_NOT_CONFIGURED'
    : /^(?:Transport error creating consumer K8s Job|Failed to create consumer Kubernetes Job)$/.test(reason)
      ? 'KUBERNETES_JOB_START_FAILED'
      : 'CONSUMER_START_FAILED';
  const reference = randomBytes(6).toString('hex');
  console.error('[mcp] workspace_create consumer startup failed', {
    reference, code, status: Number.isInteger(status) ? status : null,
    error_type: safeCode(error?.name), upstream_code: safeCode(error?.code),
  });
  const profileHint = imageProfile
    ? 'Requested image_profile=' + (['lightweight', 'browser', 'scala'].includes(imageProfile) ? imageProfile : '(unrecognized)') + '. '
    : 'If this project has no running consumer, image_profile is required. ';
  return publicError(code,
    'Could not start or attach to the shared project consumer. No MCP workspace was created. ' +
    profileHint + 'This is a consumer startup failure, not a shell-command failure. ' +
    'Inspect server producer startup and Kubernetes Job logs, then retry once the underlying issue is resolved. ' +
    'Diagnostic reference: ' + reference + '.',
    { retryable: true, cause: error });
}

export function unexpectedToolError(error, toolName) {
  if (error?.publicMessage) return error.publicMessage;
  const reference = randomBytes(6).toString('hex');
  console.error('[mcp] unclassified tool error', {
    reference, tool: toolName, error_type: safeCode(error?.name),
    upstream_code: safeCode(error?.code),
  });
  return 'MCP_INTERNAL_ERROR: ' + toolName +
    ' failed inside the AWFL service (not a tool-argument validation error). ' +
    'Check server logs using diagnostic reference ' + reference +
    '; retry only after investigating service health.';
}
