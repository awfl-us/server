import { GoogleAuth, DownscopedClient } from 'google-auth-library';

// Base auth client with read-only Storage scope
const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/devstorage.read_only'],
});

// Simple in-process cache of tokens per bucket/prefix
// Value: { token: string, expiresAt: number }
const cache = new Map();

function cacheKey(bucket, prefix) {
  return `${bucket}::${prefix || ''}`;
}

function buildCab({ bucket, prefix }) {
  const availableResource = `//storage.googleapis.com/projects/_/buckets/${bucket}`;
  const normalizedPrefix = String(prefix || '');
  const expression = `resource.name.startsWith('projects/_/buckets/${bucket}/objects/${normalizedPrefix}')`;
  return {
    accessBoundary: {
      accessBoundaryRules: [
        {
          availableResource,
          availablePermissions: ['inRole:roles/storage.objectViewer'],
          availabilityCondition: { expression },
        },
      ],
    },
  };
}

async function mintToken({ bucket, prefix }) {
  if (!bucket) throw new Error('bucket is required');
  const underlying = await auth.getClient();
  const cab = buildCab({ bucket, prefix });
  const downscopedClient = new DownscopedClient({ underlyingClient: underlying, cab });

  // Try to obtain a raw access token
  let token = null;
  try {
    const res = await downscopedClient.getAccessToken();
    token = typeof res === 'string' ? res : res?.token || null;
  } catch (_) {}

  // Fallback to extracting from request headers if needed
  if (!token) {
    const headers = await downscopedClient.getRequestHeaders();
    const authz = headers?.Authorization || headers?.authorization || '';
    token = authz.replace(/^Bearer\s+/i, '').trim();
  }

  if (!token) throw new Error('failed_to_mint_downscoped_token');

  // Downscoped tokens typically last up to 1 hour. Use a conservative TTL (10 minutes).
  const ttlMs = 10 * 60 * 1000;
  const expiresAt = Date.now() + ttlMs;
  return { token, expiresAt };
}

export async function getDownscopedToken({ bucket, prefix, force = false }) {
  const key = cacheKey(bucket, prefix);
  if (!force) {
    const entry = cache.get(key);
    if (entry && entry.token && entry.expiresAt && entry.expiresAt - Date.now() > 60 * 1000) {
      // Return cached if >60s validity remains
      return entry.token;
    }
  }

  const minted = await mintToken({ bucket, prefix });
  cache.set(key, minted);
  return minted.token;
}

export function renderPrefixTemplate(tpl, ctx) {
  const safe = String(tpl || '');
  return safe.replace(/\{(userId|projectId|workspaceId|sessionId)\}/g, (_, k) => String(ctx[k] || ''));
}
