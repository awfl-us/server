import { GoogleAuth, DownscopedClient } from 'google-auth-library';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
let GAL_VERSION = 'unknown';
try { GAL_VERSION = require('google-auth-library/package.json')?.version || 'unknown'; } catch {}

const GCS_DEBUG = /^1|true|yes$/i.test(String(process.env.GCS_DEBUG || ''));
function dlog(...args) { if (GCS_DEBUG) console.log('[producer][gcs]', ...args); }

// Whether upload back to GCS is enabled; if so, we must request wider source scopes and permissions
const GCS_ENABLE_UPLOAD = ['1','true','yes'].includes(String(process.env.GCS_ENABLE_UPLOAD || '1').toLowerCase());

// Base auth client. If uploads are enabled, request read_write; otherwise read_only
const STORAGE_SCOPE = GCS_ENABLE_UPLOAD
  ? 'https://www.googleapis.com/auth/devstorage.read_write'
  : 'https://www.googleapis.com/auth/devstorage.read_only';
const auth = new GoogleAuth({ scopes: [STORAGE_SCOPE] });

// Simple in-process cache of tokens per bucket/prefix
// Value: { token: string, expiresAt: number }
const cache = new Map();

function cacheKey(bucket, prefix) {
  return `${bucket}::${prefix || ''}`;
}

function normalizePrefix(raw) {
  const s = String(raw || '');
  if (!s) return s; // empty prefix is allowed only if explicitly enabled via ALLOW_BUCKET_WIDE_CAB
  return s.endsWith('/') ? s : `${s}/`;
}

function buildCab({ bucket, prefix, permissionMode = process.env.GCS_CAB_PERMISSION_MODE || 'explicit' }) {
  if (!bucket) throw new Error('bucket is required');
  const availableResource = `//storage.googleapis.com/projects/_/buckets/${bucket}`;
  const normalizedPrefix = normalizePrefix(prefix);

  // By default, disallow bucket-wide downscope unless explicitly allowed
  if (!normalizedPrefix && !/^1|true|yes$/i.test(String(process.env.ALLOW_BUCKET_WIDE_CAB || ''))) {
    const err = new Error('empty_prefix_not_allowed');
    err.details = { message: 'Refusing to mint bucket-wide downscoped token. Provide a non-empty prefix or set ALLOW_BUCKET_WIDE_CAB=1 to override.' };
    throw err;
  }

  const expression = `resource.name.startsWith('projects/_/buckets/${bucket}/objects/${normalizedPrefix}')`;

  let availablePermissions;
  if (String(permissionMode).toLowerCase() === 'explicit') {
    // Explicit permissions variant
    availablePermissions = ['storage.objects.get', 'storage.objects.list'];
    if (GCS_ENABLE_UPLOAD) availablePermissions.push('storage.objects.create');
  } else {
    // Role alias variant
    availablePermissions = ['inRole:roles/storage.objectViewer'];
    // Note: If uploads are enabled, explicit mode is recommended so we can add 'storage.objects.create'.
  }

  // Build the Access Boundary rules
  const accessBoundary = {
    accessBoundaryRules: [
      {
        availableResource,
        availablePermissions,
        availabilityCondition: { expression },
      },
    ],
  };

  const rules = accessBoundary?.accessBoundaryRules;
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error('invalid_access_boundary');
  }
  dlog('built CAB', { availableResource, expression, availablePermissions, permissionMode: String(permissionMode).toLowerCase(), normalizedPrefix, STORAGE_SCOPE });
  return { accessBoundary };
}

async function constructDownscopedClient(sourceClient, accessBoundary) {
  // Use canonical constructor form supported by current google-auth-library
  const downscopedClient = new DownscopedClient({ sourceClient, accessBoundary });
  return { downscopedClient, variant: 'opts_accessBoundary' };
}

async function mintTokenOnce({ bucket, prefix, permissionMode }) {
  const sourceClient = await auth.getClient();
  const { accessBoundary } = buildCab({ bucket, prefix, permissionMode });
  const { downscopedClient, variant } = await constructDownscopedClient(sourceClient, accessBoundary);

  try {
    const res = await downscopedClient.getAccessToken();
    const token = typeof res === 'string' ? res : res?.token || res?.access_token || null;
    if (!token) {
      const err = new Error('failed_to_mint_downscoped_token');
      err.details = { GAL_VERSION, variant, permissionMode };
      throw err;
    }
    // Prefer actual expiry when provided by the library
    const expiresAt = typeof res === 'object' && res?.expiry_date ? res.expiry_date : Date.now() + 10 * 60 * 1000;
    dlog('minted downscoped', { GAL_VERSION, variant, permissionMode, tokenPreview: token.slice(0, 8) + '…', expiresAt, STORAGE_SCOPE, GCS_ENABLE_UPLOAD });
    return { token, expiresAt };
  } catch (e) {
    const cause = e?.response?.data || e?.stack || String(e);
    const err = new Error(e?.message || 'mint_failed');
    err.details = { GAL_VERSION, permissionMode, cause, STORAGE_SCOPE, GCS_ENABLE_UPLOAD };
    throw err;
  }
}

async function mintToken({ bucket, prefix }) {
  if (!bucket) throw new Error('bucket is required');
  // Use selected mode directly; no cross-mode retries
  const mode = String(process.env.GCS_CAB_PERMISSION_MODE || 'explicit').toLowerCase();
  return await mintTokenOnce({ bucket, prefix, permissionMode: mode });
}

export async function getDownscopedToken({ bucket, prefix, force = false }) {
  const key = cacheKey(bucket, normalizePrefix(prefix));
  if (!force) {
    const entry = cache.get(key);
    if (entry && entry.token && entry.expiresAt && entry.expiresAt - Date.now() > 60 * 1000) {
      dlog('cache hit', { key, ttlMs: entry.expiresAt - Date.now() });
      return entry.token;
    }
  }

  const minted = await mintToken({ bucket, prefix });
  cache.set(key, minted);
  dlog('cache set', { key, expiresAt: minted.expiresAt });
  return minted.token;
}

export function renderPrefixTemplate(tpl, ctx) {
  const safe = String(tpl || '');
  return safe.replace(/\{(userId|projectId|workspaceId|sessionId)\}/g, (_, k) => String(ctx[k] || ''));
}
