import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import axios from 'axios';
import { GoogleAuth } from 'google-auth-library';
import { GCS_API_BASE, GCS_DOWNLOAD_CONCURRENCY } from './config.js';
import { resolveWithin } from './storage.js';

async function getAuthHeader(providedToken) {
  if (providedToken) return { Authorization: `Bearer ${providedToken}` };
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
    const resp = await axios.get(baseUrl, { params, headers, timeout: 30000, validateStatus: s => s < 500 });
    if (resp.status !== 200) throw new Error(`gcs_list_http_${resp.status}`);
    const data = resp.data || {};
    if (Array.isArray(data.items)) items.push(...data.items);
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  return items;
}

async function downloadObject({ bucket, objectName, destPath, headers }) {
  const url = `${GCS_API_BASE.replace(/\/$/, '')}/download/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}`;
  const resp = await axios.get(url, {
    params: { alt: 'media' },
    headers,
    responseType: 'arraybuffer',
    timeout: 120000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    validateStatus: s => s < 500,
  });
  if (resp.status !== 200) throw new Error(`gcs_download_http_${resp.status}`);
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
