import { GoogleAuth, DownscopedClient } from 'google-auth-library';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
let GAL_VERSION = 'unknown';
try { GAL_VERSION = require('google-auth-library/package.json')?.version || 'unknown'; } catch {}

const GCS_DEBUG = /^1|true|yes$/i.test(String(process.env.GCS_DEBUG || ''));
function dlog(...args) { if (GCS_DEBUG) console.log('[producer][gcs]', ...args); }

// Base auth client. Use cloud-platform to match working harness and avoid scope surprises during mint
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

// Simple in-process cache of tokens per bucket/prefix/flags
// Value: { token: string, expiresAt: number }
const cache = new Map();

function envFlag(name, def = true) {
  const raw = process.env[name];
  if (raw == null) return !!def;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function cacheKey(bucket, prefix, includeList, includeUpload) {
  return `${bucket}::${prefix || ''}::L${includeList ? 1 : 0}::U${includeUpload ? 1 : 0}`;
}

function normalizePrefix(raw) {
  const s = String(raw || '');
  if (!s) return s; // empty prefix is allowed only if explicitly enabled via ALLOW_BUCKET_WIDE_CAB
  return s.endsWith('/') ? s : `${s}/`;
}

function buildCab({ bucket, prefix, permissionMode = process.env.GCS_CAB_PERMISSION_MODE || 'explicit', includeList, includeUpload }) {
  if (!bucket) throw new Error('bucket is required');
  const availableResource = `//storage.googleapis.com/projects/_/buckets/${bucket}`;
  const normalizedPrefix = normalizePrefix(prefix);

  // By default, disallow bucket-wide downscope unless explicitly allowed
  if (!normalizedPrefix && !/^1|true|yes|on$/i.test(String(process.env.ALLOW_BUCKET_WIDE_CAB || ''))) {
    const err = new Error('empty_prefix_not_allowed');
    err.details = { message: 'Refusing to mint bucket-wide downscoped token. Provide a non-empty prefix or set ALLOW_BUCKET_WIDE_CAB=1 to override.' };
    throw err;
  }

  // Resolve runtime flags: default to true if not provided
  const wantList = includeList != null ? !!includeList : envFlag('GCS_ENABLE_LIST', true);
  const wantUpload = includeUpload != null ? !!includeUpload : envFlag('GCS_ENABLE_UPLOAD', true);

  const expression = `resource.name.startsWith('projects/_/buckets/${bucket}/objects/${normalizedPrefix}')`;

  // Map permissions to CAB inRole entries
  const map = {
    viewer: 'inRole:roles/storage.objectViewer',
    creator: 'inRole:roles/storage.objectCreator',
    deleter: 'inRole:roles/storage.objectAdmin', // includes delete
    list: 'inRole:roles/storage.legacyBucketReader',
  };

  // Rule A: object-level permissions constrained to prefix
  const availablePermissions = [map.viewer];
  if (wantUpload) availablePermissions.push(map.creator, map.deleter); // allow create + overwrite (delete)
  const accessBoundaryRules = [
    {
      availableResource,
      availablePermissions,
      availabilityCondition: { expression },
    },
  ];

  // Rule B: bucket-level list WITHOUT condition (required for storage.objects.list)
  if (wantList) {
    accessBoundaryRules.push({
      availableResource,
      availablePermissions: [map.list],
    });
  }

  const accessBoundary = { accessBoundaryRules };
  dlog('built CAB', { availableResource, expression, availablePermissions, includeList: wantList, includeUpload: wantUpload, permissionMode: String(permissionMode).toLowerCase(), normalizedPrefix });
  return { accessBoundary, includeList: wantList, includeUpload: wantUpload };
}

function variantConstructors(sourceClient, accessBoundary) {
  return [
    { name: 'opts_accessBoundary', fn: () => new DownscopedClient({ sourceClient, accessBoundary }) },
    { name: 'two_arg_accessBoundary', fn: () => new DownscopedClient(sourceClient, { accessBoundary }) },
    { name: 'opts_credentialAccessBoundary', fn: () => new DownscopedClient({ sourceClient, credentialAccessBoundary: accessBoundary }) },
    { name: 'two_arg_credentialAccessBoundary', fn: () => new DownscopedClient(sourceClient, { credentialAccessBoundary: accessBoundary }) },
  ];
}

async function tryConstructAndMint(sourceClient, accessBoundary, flags) {
  const attempts = [];
  for (const v of variantConstructors(sourceClient, accessBoundary)) {
    let client;
    try {
      client = v.fn();
      dlog('DownscopedClient constructed', { GAL_VERSION, variant: v.name });
    } catch (ctorErr) {
      attempts.push({ variant: v.name, phase: 'construct', error: String(ctorErr?.stack || ctorErr) });
      continue;
    }

    try {
      const res = await client.getAccessToken();
      const token = typeof res === 'string' ? res : res?.token || res?.access_token || null;
      if (token) {
        const expiresAt = typeof res === 'object' && res?.expiry_date ? res.expiry_date : Date.now() + 10 * 60 * 1000;
        dlog('minted downscoped', { GAL_VERSION, variant: v.name, tokenPreview: token.slice(0, 8) + '…', expiresAt, includeList: flags?.includeList, includeUpload: flags?.includeUpload });
        return { token, expiresAt, variant: v.name };
      }
      attempts.push({ variant: v.name, phase: 'mint', error: 'no_token_in_response' });
    } catch (mintErr) {
      const cause = mintErr?.response?.data || mintErr?.stack || String(mintErr);
      attempts.push({ variant: v.name, phase: 'mint', error: cause });
      if (GCS_DEBUG) {
        console.log('[producer][gcs] mint attempt failed', { GAL_VERSION, variant: v.name, cause });
      }
      continue;
    }
  }
  const err = new Error('downscope_all_variants_failed');
  err.details = { GAL_VERSION, attempts, includeList: flags?.includeList, includeUpload: flags?.includeUpload };
  throw err;
}

async function mintTokenOnce({ bucket, prefix, permissionMode, includeList, includeUpload }) {
  const sourceClient = await auth.getClient();
  const { accessBoundary, includeList: wantList, includeUpload: wantUpload } = buildCab({ bucket, prefix, permissionMode, includeList, includeUpload });
  return await tryConstructAndMint(sourceClient, accessBoundary, { includeList: wantList, includeUpload: wantUpload });
}

async function mintToken({ bucket, prefix, includeList, includeUpload }) {
  if (!bucket) throw new Error('bucket is required');
  const mode = String(process.env.GCS_CAB_PERMISSION_MODE || 'explicit').toLowerCase();
  return await mintTokenOnce({ bucket, prefix, permissionMode: mode, includeList, includeUpload });
}

export async function getDownscopedToken({ bucket, prefix, force = false, includeList, includeUpload }) {
  // Resolve runtime flags with defaults to true
  const wantList = includeList != null ? !!includeList : envFlag('GCS_ENABLE_LIST', true);
  const wantUpload = includeUpload != null ? !!includeUpload : envFlag('GCS_ENABLE_UPLOAD', true);

  const key = cacheKey(bucket, normalizePrefix(prefix), wantList, wantUpload);
  if (!force) {
    const entry = cache.get(key);
    if (entry && entry.token && entry.expiresAt && entry.expiresAt - Date.now() > 60 * 1000) {
      dlog('cache hit', { key, ttlMs: entry.expiresAt - Date.now() });
      return entry.token;
    }
  }

  const minted = await mintToken({ bucket, prefix, includeList: wantList, includeUpload: wantUpload });
  cache.set(key, minted);
  dlog('cache set', { key, expiresAt: minted.expiresAt });
  return minted.token;
}

export function renderPrefixTemplate(tpl, ctx) {
  const safe = String(tpl || '');
  return safe.replace(/\{(userId|projectId|workspaceId|sessionId)\}/g, (_, k) => String(ctx[k] || ''));
}
