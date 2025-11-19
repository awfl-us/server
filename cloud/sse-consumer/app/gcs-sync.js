import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import axios from 'axios';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { GCS_API_BASE, GCS_DOWNLOAD_CONCURRENCY } from './config.js';
import { resolveWithin } from './storage.js';

const GCS_DEBUG = /^1|true|yes$/i.test(String(process.env.GCS_DEBUG || ''));
function dlog(...args) { if (GCS_DEBUG) console.log('[consumer][gcs]', ...args); }

// Use a dedicated Axios instance to avoid any global interceptors that might override auth headers
const http = axios.create({ timeout: 30000, validateStatus: s => s < 500 });

function redactAuth(h) {
  const out = { ...(h || {}) };
  if (out.Authorization) out.Authorization = '[redacted]';
  if (out.authorization) out.authorization = '[redacted]';
  return out;
}

function makeAuthHeadersFromToken(accessToken) {
  if (!accessToken) return {};
  // Also provide a google-auth-library compatible client pathway if needed later
  const oauth = new OAuth2Client();
  oauth.setCredentials({ access_token: accessToken });
  // We still return raw headers for direct HTTP usage
  return { Authorization: `Bearer ${accessToken}` };
}

async function getAuthHeader(providedToken) {
  if (providedToken) return makeAuthHeadersFromToken(providedToken);
  try {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/devstorage.read_only'] });
    const client = await auth.getClient();
    const headers = await client.getRequestHeaders(GCS_API_BASE);
    return headers; // includes Authorization: Bearer ...
  } catch {
    return {};
  }
}

async function readManifest(manifestPath) {
  try {
    const raw = await fsp.readFile(manifestPath, 'utf8');
    const json = JSON.parse(raw);
    return typeof json === 'object' && json ? json : {};
  } catch {
    return {};
  }
}

async function writeManifest(manifestPath, manifest) {
  try {
    const tmp = `${manifestPath}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(manifest, null, 2));
    await fsp.rename(tmp, manifestPath);
  } catch (_) {}
}

// Debug helper: test the caller's effective permissions with current Authorization header
async function debugTestPermissions({ bucket, permissions, headers }) {
  try {
    const baseUrl = `${GCS_API_BASE.replace(/\/$/, '')}/storage/v1/b/${encodeURIComponent(bucket)}/iam/testPermissions`;
    // Build query string with repeated permissions params to match API expectations
    const qs = (Array.isArray(permissions) ? permissions : [permissions]).map(p => `permissions=${encodeURIComponent(p)}`).join('&');
    const url = `${baseUrl}?${qs}`;

    const preview = String(headers?.Authorization || '').replace(/^Bearer\s+/, '').slice(0, 8);
    dlog('testPermissions request', { url, hasAuth: Boolean(headers?.Authorization), tokenPreview: preview ? `${preview}…` : '' });

    const resp = await http.get(url, { headers });
    if (resp.status === 200) {
      dlog('testPermissions response', { permissions: resp?.data?.permissions || [], status: resp.status });
    } else {
      // eslint-disable-next-line no-console
      console.warn('[consumer][gcs] testPermissions error', {
        status: resp.status,
        respHeaders: resp?.headers,
        respData: resp?.data,
        reqHeaders: redactAuth(headers),
        bucket,
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[consumer][gcs] testPermissions threw', err?.message || String(err));
  }
}

async function listAllObjects({ bucket, prefix, headers }) {
  const items = [];
  let pageToken = undefined;
  const baseUrl = `${GCS_API_BASE.replace(/\/$/, '')}/storage/v1/b/${encodeURIComponent(bucket)}/o`;

  while (true) {
    const params = {
      prefix,
      pageToken,
      fields: 'items(name,etag,generation,updated,md5Hash,size),nextPageToken',
    };

    if (GCS_DEBUG) {
      const preview = String(headers?.Authorization || '').replace(/^Bearer\s+/, '').slice(0, 8);
      dlog('list page', { baseUrl, hasAuth: Boolean(headers?.Authorization), tokenPreview: preview ? `${preview}…` : '', bucket, prefix, pageToken });
    }

    const resp = await http.get(baseUrl, { params, headers });

    if (resp.status === 404) {
      // Treat non-existent bucket/prefix as empty on initial sync to avoid hard failure
      dlog('list returned 404; treating as empty', { bucket, prefix });
      return items;
    }
    if (resp.status !== 200) {
      if (GCS_DEBUG) {
        // eslint-disable-next-line no-console
        console.warn('[consumer][gcs] list error', {
          url: baseUrl,
          params,
          status: resp.status,
          respHeaders: resp?.headers,
          respData: resp?.data,
          reqHeaders: redactAuth(headers),
          bucket,
          prefix,
        });
      }
      const err = new Error(`gcs_list_http_${resp.status}`);
      err.details = {
        bucket,
        prefix,
        status: resp.status,
        response: { headers: resp?.headers, data: resp?.data },
      };
      // If a downscoped token was provided and we hit 403 on list, hint about bucket-level list permission
      if (resp.status === 403 && headers?.Authorization && GCS_DEBUG) {
        // eslint-disable-next-line no-console
        console.warn('[consumer][gcs] hint', '403 with provided token. Ensure the source SA used to mint the token has storage.objects.list on the bucket, and CAB/IAM conditions allow list at the bucket resource.');
      }
      throw err;
    }

    const data = resp.data || {};
    if (Array.isArray(data.items)) items.push(...data.items);
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  return items;
}

async function downloadObject({ bucket, objectName, destPath, headers }) {
  const url = `${GCS_API_BASE.replace(/\/$/, '')}/download/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}`;
  const resp = await http.get(url, {
    params: { alt: 'media' },
    headers,
    responseType: 'arraybuffer',
    timeout: 120000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  if (resp.status === 404) {
    dlog('download 404 (skipping)', { bucket, objectName });
    return;
  }
  if (resp.status !== 200) {
    if (GCS_DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[consumer][gcs] download error', {
        url,
        status: resp.status,
        respHeaders: resp?.headers,
        // do not log body for potential large binary; include type/size instead
        respBodyInfo: resp?.data ? { type: typeof resp.data, length: (resp.data?.length || 0) } : null,
        reqHeaders: redactAuth(headers),
        bucket,
        objectName,
      });
    }
    throw new Error(`gcs_download_http_${resp.status}`);
  }
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  await fsp.writeFile(destPath, resp.data);
}

function limitConcurrency(limit) {
  const queue = [];
  let active = 0;
  async function run(fn) {
    if (active >= limit) await new Promise(resolve => queue.push(resolve));
    active++;
    try { return await fn(); }
    finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  }
  return run;
}

export async function syncBucketPrefix({ bucket, prefix, workRoot, token }) {
  if (!bucket) throw new Error('missing_bucket');
  const authz = await getAuthHeader(token);

  // When debugging, verify effective permissions of the current Authorization header
  if (GCS_DEBUG && authz?.Authorization) {
    await debugTestPermissions({ bucket, permissions: ['storage.objects.list'], headers: authz });
  }

  const manifestPath = path.join(workRoot, '.gcs-manifest.json');
  const manifest = await readManifest(manifestPath);

  const all = await listAllObjects({ bucket, prefix, headers: authz });
  const toDownload = [];

  for (const it of all) {
    const name = it?.name || '';
    if (!name || name.endsWith('/')) continue; // skip folder markers
    let rel = name.startsWith(prefix) ? name.slice(prefix.length) : name;
    rel = rel.replace(/^\/+/, '');
    if (!rel) continue;

    const current = manifest[name];
    const want = it?.etag || it?.generation || '';
    if (current && want && (current === want || String(current) === String(want))) continue; // up-to-date

    const dest = resolveWithin(workRoot, rel);
    toDownload.push({ name, dest, want });
  }

  const run = limitConcurrency(Math.max(1, GCS_DOWNLOAD_CONCURRENCY));
  let completed = 0;
  for (const file of toDownload) {
    // eslint-disable-next-line no-await-in-loop
    await run(async () => {
      await downloadObject({ bucket, objectName: file.name, destPath: file.dest, headers: authz });
      manifest[file.name] = file.want;
      completed++;
    });
  }

  await writeManifest(manifestPath, manifest);
  return { scanned: all.length, downloaded: toDownload.length, updated: completed };
}
