import { GoogleAuth, DownscopedClient } from 'google-auth-library';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
let GAL_VERSION = 'unknown';
try { GAL_VERSION = require('google-auth-library/package.json')?.version || 'unknown'; } catch {}

const GCS_DEBUG = /^1|true|yes$/i.test(String(process.env.GCS_DEBUG || ''));
function dlog(...args) { if (GCS_DEBUG) console.log('[producer][gcs]', ...args); }

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

function normalizePrefix(raw) {
  const s = String(raw || '');
  if (!s) return s; // empty prefix is allowed
  return s.endsWith('/') ? s : `${s}/`;
}

function buildCab({ bucket, prefix, permissionMode = process.env.GCS_CAB_PERMISSION_MODE || 'explicit' }) {
  if (!bucket) throw new Error('bucket is required');
  const availableResource = `//storage.googleapis.com/projects/_/buckets/${bucket}`;
  const normalizedPrefix = normalizePrefix(prefix);
  const expression = `resource.name.startsWith('projects/_/buckets/${bucket}/objects/${normalizedPrefix}')`;

  let availablePermissions;
  if (String(permissionMode).toLowerCase() === 'explicit') {
    // Explicit permissions variant
    availablePermissions = ['storage.objects.get', 'storage.objects.list'];
  } else {
    // Role alias variant (broadest compatibility)
    availablePermissions = ['inRole:roles/storage.objectViewer'];
  }

  // Build the Access Boundary rules (v9-compatible shape)
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
  dlog('built CAB', { availableResource, expression, availablePermissions, permissionMode: String(permissionMode).toLowerCase(), normalizedPrefix });
  return { accessBoundary };
}

async function constructDownscopedClient(sourceClient, accessBoundary) {
  let downscopedClient;
  let variant = '';
  const errors = [];

  try {
    downscopedClient = new DownscopedClient(sourceClient, { accessBoundary });
    variant = 'two_arg_accessBoundary';
  } catch (e1) {
    errors.push(`two_arg_accessBoundary:${e1?.message || e1}`);
    try {
      downscopedClient = new DownscopedClient({ sourceClient, accessBoundary });
      variant = 'opts_accessBoundary';
    } catch (e2) {
      errors.push(`opts_accessBoundary:${e2?.message || e2}`);
      try {
        downscopedClient = new DownscopedClient({ sourceClient, credentialAccessBoundary: accessBoundary });
        variant = 'opts_credentialAccessBoundary';
      } catch (e3) {
        errors.push(`opts_credentialAccessBoundary:${e3?.message || e3}`);
        try {
          downscopedClient = new DownscopedClient(sourceClient, { credentialAccessBoundary: accessBoundary });
          variant = 'two_arg_credentialAccessBoundary';
        } catch (e4) {
          errors.push(`two_arg_credentialAccessBoundary:${e4?.message || e4}`);
          const err = new Error('DownscopedClient_ctor_failed');
          err.details = { GAL_VERSION, errors };
          throw err;
        }
      }
    }
  }

  return { downscopedClient, variant };
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
    dlog('minted downscoped', { GAL_VERSION, variant, permissionMode, tokenPreview: token.slice(0, 8) + '…' });

    const ttlMs = 10 * 60 * 1000; // 10 minutes conservative TTL
    return { token, expiresAt: Date.now() + ttlMs };
  } catch (e) {
    const cause = e?.response?.data || e?.stack || String(e);
    const err = new Error(e?.message || 'mint_failed');
    err.details = { GAL_VERSION, variant, permissionMode, cause };
    throw err;
  }
}

async function mintToken({ bucket, prefix }) {
  if (!bucket) throw new Error('bucket is required');

  // Default to explicit unless overridden via env
  const envMode = String(process.env.GCS_CAB_PERMISSION_MODE || 'explicit').toLowerCase();
  if (envMode === 'explicit') {
    return await mintTokenOnce({ bucket, prefix, permissionMode: 'explicit' });
  }

  // If explicitly set to role, try role-based first (most broadly compatible)
  try {
    return await mintTokenOnce({ bucket, prefix, permissionMode: 'role' });
  } catch (e1) {
    dlog('role-based CAB mint failed; will try explicit perms', e1?.details || e1?.message || e1);
    const causeErr = (e1?.details?.cause && JSON.stringify(e1.details.cause)) || '';
    const isInvalidReq = String(e1?.message || '').includes('invalid_request') || causeErr.includes('invalid_request');
    // Retry only if STS says invalid_request; otherwise bubble up
    if (!isInvalidReq) throw e1;
    // Retry with explicit permissions
    try {
      return await mintTokenOnce({ bucket, prefix, permissionMode: 'explicit' });
    } catch (e2) {
      // Bubble up second failure with both attempts info
      const err = new Error('downscope_mint_failed_after_retries');
      err.details = { first: e1?.details || String(e1), second: e2?.details || String(e2) };
      throw err;
    }
  }
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
