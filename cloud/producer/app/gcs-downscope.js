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

function buildCab({ bucket, prefix }) {
  if (!bucket) throw new Error('bucket is required');
  const availableResource = `//storage.googleapis.com/projects/_/buckets/${bucket}`;
  const normalizedPrefix = String(prefix || '');
  const expression = `resource.name.startsWith('projects/_/buckets/${bucket}/objects/${normalizedPrefix}')`;
  const cab = {
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
  const rules = cab?.accessBoundary?.accessBoundaryRules;
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error('invalid_access_boundary');
  }
  dlog('built CAB', { availableResource, expression });
  return cab;
}

function ctorCandidates(underlying, cab) {
  const inner = cab?.accessBoundary || cab;
  // Return labelled constructors; we'll probe each until one mints a token
  return [
    ['opts_accessBoundary_sourceClient', () => new DownscopedClient({ accessBoundary: inner, sourceClient: underlying })],
    ['opts_credentialAccessBoundary_sourceClient', () => new DownscopedClient({ credentialAccessBoundary: inner, sourceClient: underlying })],
    ['opts_accessBoundary_sourceCredential', () => new DownscopedClient({ accessBoundary: inner, sourceCredential: underlying })],
    ['opts_credentialAccessBoundary_sourceCredential', () => new DownscopedClient({ credentialAccessBoundary: inner, sourceCredential: underlying })],
    ['opts_accessBoundary_client', () => new DownscopedClient({ accessBoundary: inner, client: underlying })],
    ['opts_credentialAccessBoundary_client', () => new DownscopedClient({ credentialAccessBoundary: inner, client: underlying })],
    ['two_arg_wrapper', () => new DownscopedClient(underlying, cab)],
    ['two_arg_inner', () => new DownscopedClient(underlying, inner)],
  ];
}

async function tryMintWith(label, mkClient) {
  let client;
  try {
    client = mkClient();
  } catch (e) {
    dlog('ctor failed', label, e?.message || e);
    return { ok: false, label, step: 'ctor', err: e };
  }
  // Probe by trying to actually produce a token (first via getAccessToken, then headers)
  try {
    const res = await client.getAccessToken();
    const token = typeof res === 'string' ? res : res?.token || res?.access_token || null;
    if (token) return { ok: true, label, token };
  } catch (e) {
    dlog('getAccessToken failed', label, e?.message || e);
  }
  try {
    const headers = await client.getRequestHeaders();
    const authz = headers?.Authorization || headers?.authorization || '';
    const token = authz.replace(/^Bearer\s+/i, '').trim();
    if (token) return { ok: true, label, token };
  } catch (e) {
    dlog('getRequestHeaders failed', label, e?.message || e);
  }
  return { ok: false, label, step: 'mint', err: new Error('no_token_from_variant') };
}

async function mintToken({ bucket, prefix }) {
  if (!bucket) throw new Error('bucket is required');
  const underlying = await auth.getClient();
  const cab = buildCab({ bucket, prefix });

  const attempts = ctorCandidates(underlying, cab);
  const errors = [];
  for (const [label, mk] of attempts) {
    const res = await tryMintWith(label, mk);
    if (res.ok && res.token) {
      dlog('minted via', label, { GAL_VERSION, tokenPreview: res.token.slice(0, 8) + '…' });
      const ttlMs = 10 * 60 * 1000; // 10 minutes conservative TTL
      return { token: res.token, expiresAt: Date.now() + ttlMs };
    }
    errors.push(`${res.label}:${res.step}:${res.err?.message || res.err}`);
  }

  dlog('all mint attempts failed', { GAL_VERSION, errors });
  const e = new Error(errors[0] || 'failed_to_mint_downscoped_token');
  e.details = { GAL_VERSION, errors };
  throw e;
}

export async function getDownscopedToken({ bucket, prefix, force = false }) {
  const key = cacheKey(bucket, prefix);
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
