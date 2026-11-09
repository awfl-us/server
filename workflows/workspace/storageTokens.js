/** Project-isolated GCS credential broker for the existing GKE consumer. */
import { GoogleAuth, DownscopedClient } from 'google-auth-library';

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

function safeSegment(value) {
  if (typeof value !== 'string' || !value || value.length > 128 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Invalid workspace identity');
  }
  // encodeURIComponent leaves apostrophes and parentheses unescaped; they
  // cannot be interpolated into a CEL single-quoted string safely.
  return encodeURIComponent(value).replace(/[!'()*]/g,
    ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
}

export function projectWorkspacePrefix(userId, projectId) {
  return `users/${safeSegment(userId)}/projects/${safeSegment(projectId)}/files/`;
}

export function buildWorkspaceCab(bucket, prefix) {
  if (!/^[a-z0-9][a-z0-9._-]{2,221}$/.test(bucket) || !prefix.endsWith('/') ||
      prefix.startsWith('/') || !/^[A-Za-z0-9_~%.\/-]+$/.test(prefix)) {
    throw new Error('Invalid GCS workspace boundary');
  }
  const objectPath = `projects/_/buckets/${bucket}/objects/${prefix}`;
  // The list prefix is an API attribute; resource.name alone would deny list,
  // and a separate unconditional list rule would expose other projects' names.
  const condition = `resource.name.startsWith('${objectPath}') || ` +
    `api.getAttribute('storage.googleapis.com/objectListPrefix', '').startsWith('${prefix}')`;
  return {
    accessBoundary: {
      accessBoundaryRules: [{
        availableResource: `//storage.googleapis.com/projects/_/buckets/${bucket}`,
        availablePermissions: ['inRole:roles/storage.objectAdmin'],
        availabilityCondition: { expression: condition },
      }],
    },
  };
}

export async function mintWorkspaceToken({ userId, projectId, bucket }) {
  const prefix = projectWorkspacePrefix(userId, projectId);
  const boundary = buildWorkspaceCab(bucket, prefix);
  const sourceClient = await auth.getClient();
  // Server pins google-auth-library v9: its constructor takes positional
  // (sourceClient, credentialAccessBoundary), unlike newer examples.
  const client = new DownscopedClient(sourceClient, boundary);
  const result = await client.getAccessToken();
  if (!result?.token) throw new Error('GCS token exchange returned no token');
  // Request another token well before the STS token expiry. Never disclose the
  // source service-account token or expose a path supplied by the client.
  const remaining = Number.isFinite(result.expirationTime)
    ? Math.floor((result.expirationTime - Date.now()) / 1000)
    : 600;
  return { bucket, prefix, accessToken: result.token, expiresIn: Math.max(1, Math.min(600, remaining)) };
}
