import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import axios from 'axios';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { GCS_API_BASE, GCS_DOWNLOAD_CONCURRENCY, GCS_UPLOAD_CONCURRENCY, GCS_ENABLE_UPLOAD, GCS_BILLING_PROJECT } from './config.js';
import { resolveWithin } from './storage.js';

// Fine-grained control: TRACE enables very verbose per-request logging; DEBUG enables concise error/context logs
const GCS_TRACE = /^1|true|yes$/i.test(String(process.env.GCS_TRACE || ''));
const GCS_DEBUG = /^1|true|yes$/i.test(String(process.env.GCS_DEBUG || ''));
function dtrace(...args) { if (GCS_TRACE) console.log('[consumer][gcs]', ...args); }

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

function withRequesterPays({ headers = {}, params = {} } = {}) {
  const out = { headers: { ...headers }, params: { ...params } };
  if (GCS_BILLING_PROJECT) {
    out.headers['x-goog-user-project'] = GCS_BILLING_PROJECT;
    // For APIs that support it (objects list/get/upload), include userProject query param
    out.params.userProject = GCS_BILLING_PROJECT;
  }
  return out;
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
  if (!GCS_TRACE) return; // suppress unless explicitly tracing
  try {
    const baseUrl = `${GCS_API_BASE.replace(/\/$/, '')}/storage/v1/b/${encodeURIComponent(bucket)}/iam/testPermissions`;
    // Build query string with repeated permissions params to match API expectations
    const qs = (Array.isArray(permissions) ? permissions : [permissions]).map(p => `permissions=${encodeURIComponent(p)}`).join('&');
    const url = `${baseUrl}?${qs}`;

    const preview = String(headers?.Authorization || '').replace(/^Bearer\s+/, '').slice(0, 8);
    const extra = withRequesterPays({ headers });
    dtrace('testPermissions request', { url, hasAuth: Boolean(headers?.Authorization), tokenPreview: preview ? `${preview}…` : '' });

    const resp = await http.get(url, { headers: extra.headers });
    if (resp.status === 200) {
      dtrace('testPermissions response', { permissions: resp?.data?.permissions || [], status: resp.status });
    } else if (GCS_DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[consumer][gcs] testPermissions error', {
        status: resp.status,
        respHeaders: resp?.headers,
        respData: resp?.data,
        reqHeaders: redactAuth(extra.headers),
        bucket,
      });
    }
  } catch (err) {
    if (GCS_DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[consumer][gcs] testPermissions threw', err?.message || String(err));
    }
  }
}

async function listAllObjects({ bucket, prefix, headers }) {
  const items = [];
  let pageToken = undefined;
  const baseUrl = `${GCS_API_BASE.replace(/\/$/, '')}/storage/v1/b/${encodeURIComponent(bucket)}/o`;

  while (true) {
    const merged = withRequesterPays({ headers, params: { prefix, pageToken, fields: 'items(name,etag,generation,updated,md5Hash,size),nextPageToken' } });

    if (GCS_TRACE) {
      const preview = String(merged.headers?.Authorization || '').replace(/^Bearer\s+/, '').slice(0, 8);
      dtrace('list page', { baseUrl, hasAuth: Boolean(merged.headers?.Authorization), tokenPreview: preview ? `${preview}…` : '', bucket, prefix, pageToken });
    }

    const resp = await http.get(baseUrl, { params: merged.params, headers: merged.headers });

    if (resp.status === 404) {
      if (GCS_DEBUG) dtrace('list returned 404; treating as empty', { bucket, prefix });
      return items;
    }
    if (resp.status !== 200) {
      const message = resp?.data?.error?.message;
      const reasons = Array.isArray(resp?.data?.error?.errors) ? resp.data.error.errors.map(e => e?.reason).filter(Boolean) : undefined;

      // Always emit a concise error summary including JSON body fields if present
      // eslint-disable-next-line no-console
      console.warn('[consumer][gcs] list error summary', {
        status: resp.status,
        message,
        reasons,
        bucket,
        prefix,
        billingProjectUsed: Boolean(GCS_BILLING_PROJECT),
        userProject: GCS_BILLING_PROJECT || undefined,
      });

      if (GCS_TRACE) {
        // eslint-disable-next-line no-console
        console.warn('[consumer][gcs] list error', {
          url: baseUrl,
          params: merged.params,
          status: resp.status,
          respHeaders: resp?.headers,
          respData: resp?.data,
          reqHeaders: redactAuth(merged.headers),
          bucket,
          prefix,
        });
      }
      const err = new Error(`gcs_list_http_${resp.status}`);
      err.details = {
        bucket,
        prefix,
        status: resp.status,
        message,
        reasons,
        billingProjectUsed: Boolean(GCS_BILLING_PROJECT),
        response: { headers: resp?.headers, data: resp?.data },
      };
      // If a downscoped token was provided and we hit 403 on list, hint about bucket-level list permission
      if (resp.status === 403 && merged.headers?.Authorization && GCS_DEBUG) {
        // eslint-disable-next-line no-console
        console.warn('[consumer][gcs] hint', '403 with provided token. Ensure the source SA used to mint the token has storage.objects.list on the bucket, check requester-pays billing (userProject), and confirm CAB condition prefix matches the request prefix.');
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
  const merged = withRequesterPays({ headers, params: { alt: 'media' } });
  const resp = await http.get(url, {
    params: merged.params,
    headers: merged.headers,
    responseType: 'arraybuffer',
    timeout: 120000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  if (resp.status === 404) {
    if (GCS_DEBUG) dtrace('download 404 (skipping)', { bucket, objectName });
    return false;
  }
  if (resp.status !== 200) {
    if (GCS_TRACE) {
      // eslint-disable-next-line no-console
      console.warn('[consumer][gcs] download error', {
        url,
        status: resp.status,
        respHeaders: resp?.headers,
        // do not log body for potential large binary; include type/size instead
        respBodyInfo: resp?.data ? { type: typeof resp.data, length: (resp.data?.length || 0) } : null,
        reqHeaders: redactAuth(merged.headers),
        bucket,
        objectName,
      });
    }
    const message = resp?.data?.error?.message;
    const reasons = Array.isArray(resp?.data?.error?.errors) ? resp.data.error.errors.map(e => e?.reason).filter(Boolean) : undefined;
    const err = new Error(`gcs_download_http_${resp.status}`);
    err.details = { status: resp.status, message, reasons, billingProjectUsed: Boolean(GCS_BILLING_PROJECT), response: resp?.data };
    throw err;
  }
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  await fsp.writeFile(destPath, resp.data);
  return true;
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

function guessContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.txt': return 'text/plain; charset=utf-8';
    case '.md': return 'text/markdown; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.ts': return 'application/typescript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.html': case '.htm': return 'text/html; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.pdf': return 'application/pdf';
    default: return 'application/octet-stream';
  }
}

async function uploadObject({ bucket, objectName, filePath, headers, ifGenerationMatch }) {
  const url = `${GCS_API_BASE.replace(/\/$/, '')}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`;
  const merged = withRequesterPays({ headers, params: { uploadType: 'media', name: objectName } });
  if (ifGenerationMatch !== undefined && ifGenerationMatch !== null) merged.params.ifGenerationMatch = String(ifGenerationMatch);
  const contentType = guessContentType(filePath);
  const data = await fsp.readFile(filePath);

  const resp = await http.post(url, data, { params: merged.params, headers: { ...merged.headers, 'Content-Type': contentType } });
  if (resp.status !== 200) {
    if (GCS_TRACE) {
      // eslint-disable-next-line no-console
      console.warn('[consumer][gcs] upload error', {
        url,
        params: merged.params,
        status: resp.status,
        respHeaders: resp?.headers,
        respData: resp?.data,
        reqHeaders: redactAuth(merged.headers),
        bucket,
        objectName,
      });
    }
    const message = resp?.data?.error?.message;
    const reasons = Array.isArray(resp?.data?.error?.errors) ? resp.data.error.errors.map(e => e?.reason).filter(Boolean) : undefined;
    const err = new Error(`gcs_upload_http_${resp.status}`);
    err.details = { status: resp.status, message, reasons, billingProjectUsed: Boolean(GCS_BILLING_PROJECT), response: resp?.data };
    throw err;
  }
  return resp.data; // object resource with generation, etc.
}

function normalizeManifestRecord(rec) {
  if (rec == null) return null;
  if (typeof rec === 'string') return { remoteGen: String(rec) };
  const out = { ...rec };
  if (out.remoteGen != null) out.remoteGen = String(out.remoteGen);
  return out;
}

function relFromName(name, prefix) {
  const n = String(name || '');
  const p = String(prefix || '');
  let rel = n.startsWith(p) ? n.slice(p.length) : n;
  // tolerate historical double slashes after prefix
  rel = rel.replace(/^\/+/, '');
  return rel;
}

async function walkLocalFiles(rootDir) {
  const results = [];
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(rootDir, abs);
      if (rel === '.gcs-manifest.json') continue; // skip manifest
      if (ent.isDirectory()) {
        await walk(abs);
      } else if (ent.isFile()) {
        try {
          const st = await fsp.stat(abs);
          results.push({ rel, abs, stat: st });
        } catch {}
      }
    }
  }
  await walk(rootDir);
  return results;
}

export async function syncBucketPrefix({ bucket, prefix, workRoot, token }) {
  if (!bucket) throw new Error('missing_bucket');
  const authz = await getAuthHeader(token);

  // When tracing, verify effective permissions of the current Authorization header
  if (GCS_TRACE && authz?.Authorization) {
    const perms = ['storage.objects.list'];
    if (GCS_ENABLE_UPLOAD) perms.push('storage.objects.create');
    await debugTestPermissions({ bucket, permissions: perms, headers: authz });
  }

  const manifestPath = path.join(workRoot, '.gcs-manifest.json');
  const manifest = await readManifest(manifestPath);

  // Index current remote objects
  const all = await listAllObjects({ bucket, prefix, headers: authz });
  const remoteIndex = Object.create(null);
  for (const it of all) { if (it?.name) remoteIndex[it.name] = it; }

  // Build helper indexes to bridge historical key variants
  const manifestByRel = Object.create(null);
  for (const name of Object.keys(manifest)) {
    const rel = relFromName(name, prefix);
    if (rel) manifestByRel[rel] = name; // first write wins; stable
  }
  const remoteByRel = Object.create(null);
  for (const name of Object.keys(remoteIndex)) {
    const rel = relFromName(name, prefix);
    if (rel && remoteByRel[rel] == null) remoteByRel[rel] = name;
  }

  // Determine downloads (remote -> local) based on generation
  const toDownload = [];
  for (const it of all) {
    const name = it?.name || '';
    if (!name || name.endsWith('/')) continue; // skip folder markers
    const rel = relFromName(name, prefix);
    if (!rel) continue;

    const current = normalizeManifestRecord(manifest[name]);
    const wantGen = String(it?.generation || '');
    if (current?.remoteGen && current.remoteGen === wantGen) continue; // up-to-date

    const dest = resolveWithin(workRoot, rel);
    toDownload.push({ name, dest, wantGen });
  }

  const runDl = limitConcurrency(Math.max(1, GCS_DOWNLOAD_CONCURRENCY));
  let downloaded = 0;
  for (const file of toDownload) {
    // eslint-disable-next-line no-await-in-loop
    await runDl(async () => {
      const ok = await downloadObject({ bucket, objectName: file.name, destPath: file.dest, headers: authz });
      if (ok) {
        try {
          const st = await fsp.stat(file.dest);
          manifest[file.name] = { remoteGen: file.wantGen, localMtime: st.mtimeMs, localSize: st.size };
        } catch {
          manifest[file.name] = { remoteGen: file.wantGen };
        }
        downloaded++;
      }
    });
  }

  // Determine uploads (local -> remote) if enabled
  let uploaded = 0;
  let conflicts = 0;
  if (GCS_ENABLE_UPLOAD) {
    const locals = await walkLocalFiles(workRoot);
    const runUl = limitConcurrency(Math.max(1, GCS_UPLOAD_CONCURRENCY));

    for (const lf of locals) {
      const rel = lf.rel.replace(/^\\+/, '').replace(/^\/+/, '');
      if (!rel) continue;

      // Prefer existing remote/manifest mapping for this rel to avoid // vs / key drift
      const mappedName = manifestByRel[rel] ?? remoteByRel[rel];
      const objectName = mappedName || `${prefix}${rel}`;

      const prev = normalizeManifestRecord(manifest[objectName] || (mappedName ? manifest[mappedName] : null));
      const remote = remoteIndex[objectName] || (mappedName ? remoteIndex[mappedName] : undefined);

      // Determine if local file changed since last sync
      const changedLocally = !(prev && prev.localMtime === lf.stat.mtimeMs && prev.localSize === lf.stat.size);
      if (!changedLocally) continue;

      // Conflict detection: if remote exists and its generation differs from what we recorded, skip
      if (remote && prev && prev.remoteGen && String(remote.generation) !== String(prev.remoteGen)) {
        conflicts++;
        if (GCS_DEBUG && GCS_TRACE) {
          // eslint-disable-next-line no-console
          console.warn('[consumer][gcs] skip upload due to remote conflict', { objectName, remoteGen: String(remote.generation), prevRemoteGen: String(prev.remoteGen) });
        }
        continue;
      }

      // If manifest missing and remote exists, avoid overwriting unknown remote state
      if (!prev && remote) {
        conflicts++;
        if (GCS_DEBUG && GCS_TRACE) {
          // eslint-disable-next-line no-console
          console.warn('[consumer][gcs] skip upload of untracked file; remote exists', { objectName, remoteGen: String(remote.generation) });
        }
        continue;
      }

      // Prepare conditional upload
      let ifMatch = undefined;
      if (remote && prev && prev.remoteGen) {
        ifMatch = String(prev.remoteGen);
      } else if (!remote) {
        // Only create if object does not exist
        ifMatch = '0';
      }

      // eslint-disable-next-line no-await-in-loop
      await runUl(async () => {
        try {
          const obj = await uploadObject({ bucket, objectName, filePath: lf.abs, headers: authz, ifGenerationMatch: ifMatch });
          manifest[objectName] = { remoteGen: String(obj?.generation || ''), localMtime: lf.stat.mtimeMs, localSize: lf.stat.size };
          uploaded++;
        } catch (err) {
          if (GCS_TRACE) {
            // eslint-disable-next-line no-console
            console.warn('[consumer][gcs] upload failed', { objectName, message: err?.message, details: err?.details });
          }
          // Permission denied is common when provided token is read-only; count as conflict to surface
          if (String(err?.message || '').includes('gcs_upload_http_403')) conflicts++;
        }
      });
    }
  }

  await writeManifest(manifestPath, manifest);
  return { scannedRemote: all.length, downloaded, uploaded, conflicts };
}
