import express from 'express';
import Busboy from 'busboy';
import axios from 'axios';
import { GoogleAuth } from 'google-auth-library';

// Minimal, safe content-type guessing fallback
function guessContentType(filename) {
  const n = String(filename || '').toLowerCase();
  if (n.endsWith('.txt')) return 'text/plain; charset=utf-8';
  if (n.endsWith('.md')) return 'text/markdown; charset=utf-8';
  if (n.endsWith('.json')) return 'application/json; charset=utf-8';
  if (n.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (n.endsWith('.ts')) return 'application/typescript; charset=utf-8';
  if (n.endsWith('.css')) return 'text/css; charset=utf-8';
  if (n.endsWith('.html') || n.endsWith('.htm')) return 'text/html; charset=utf-8';
  if (n.endsWith('.svg')) return 'image/svg+xml';
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  if (n.endsWith('.gif')) return 'image/gif';
  if (n.endsWith('.pdf')) return 'application/pdf';
  return 'application/octet-stream';
}

function sanitizeRelPath(p) {
  const s = String(p || '').replace(/\\/g, '/');
  const noLead = s.replace(/^\/+/, '');
  if (noLead.includes('..')) throw new Error('invalid_path');
  if (noLead.endsWith('/')) return noLead.slice(0, -1);
  return noLead;
}

function buildPrefix({ userId, projectId, overridePrefix }) {
  const p = String(overridePrefix || '').trim();
  if (p) return p.replace(/\\/g, '/').replace(/(^\/+|\/+$)/g, '') + '/';
  // Default: user/project path
  const u = String(userId || '').trim();
  const pr = String(projectId || '').trim();
  if (!u || !pr) throw new Error('missing_user_or_project');
  return `${u}/${pr}/`;
}

async function getAuthHeaders() {
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/devstorage.read_write'] });
  const client = await auth.getClient();
  const headers = await client.getRequestHeaders('https://www.googleapis.com');
  return headers; // includes Authorization: Bearer ...
}

function parseAllowedTypes() {
  const v = process.env.FS_UPLOAD_ALLOWED_TYPES || process.env.FILE_UPLOAD_ALLOWED_TYPES || '';
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function mimeMatches(pattern, actual) {
  if (!pattern || !actual) return false;
  const p = pattern.toLowerCase();
  const a = actual.toLowerCase();
  if (p.endsWith('/*')) {
    const base = p.slice(0, -1); // retain trailing slash
    return a.startsWith(base);
  }
  return p === a;
}

const router = express.Router();

// POST /workflows/services/filesystem/upload
// Multipart form fields:
// - file: file content (required)
// - dest: relative path under the computed prefix (required)
// - prefix: optional explicit GCS prefix to use; defaults to userId/projectId/
// - contentType: optional override content type
// Limits: default 25MB via FS_UPLOAD_MAX_BYTES; optional type gate via FS_UPLOAD_ALLOWED_TYPES (comma-separated, supports */* wildcards like image/*)
// Example:
//   curl -X POST "$BASE/workflows/services/filesystem/upload" \
//     -H "x-project-id: <projectId>" -H "Authorization: Bearer <token>" \
//     -F "dest=inputs/readme.txt" -F "file=@README.md"
router.post('/upload', async (req, res) => {
  try {
    const userId = req.userId;
    const projectId = req.projectId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing user context' });
    if (!projectId) return res.status(400).json({ error: 'Missing x-project-id header' });

    const bucket = process.env.GCS_BUCKET || '';
    if (!bucket) return res.status(500).json({ error: 'Server missing GCS_BUCKET' });

    const bb = Busboy({ headers: req.headers, limits: { fileSize: Number(process.env.FS_UPLOAD_MAX_BYTES || 25 * 1024 * 1024), files: 1, fields: 10 } });

    let dest = '';
    let overridePrefix = '';
    let contentTypeOverride = '';
    let gotFile = false;
    let fileFieldname = '';
    let filename = '';
    let mimeFromForm = '';
    let fileStream = null;

    const done = new Promise((resolve, reject) => {
      bb.on('field', (name, val) => {
        if (name === 'dest') dest = String(val || '');
        if (name === 'prefix') overridePrefix = String(val || '');
        if (name === 'contentType') contentTypeOverride = String(val || '');
      });
      bb.on('file', (fieldname, stream, info) => {
        if (gotFile) { stream.resume(); return; }
        gotFile = true;
        fileFieldname = fieldname;
        filename = info?.filename || 'upload.bin';
        mimeFromForm = info?.mimeType || '';
        fileStream = stream;
      });
      bb.on('error', reject);
      bb.on('finish', resolve);
      bb.on('filesLimit', () => reject(new Error('Too many files')));
    });

    req.pipe(bb);
    await done;

    if (!gotFile || !fileStream) return res.status(400).json({ error: 'Missing file' });
    if (!dest) return res.status(400).json({ error: 'Missing dest path' });

    let prefix;
    try {
      prefix = buildPrefix({ userId, projectId, overridePrefix });
    } catch (e) {
      return res.status(400).json({ error: 'Invalid prefix or context', details: String(e?.message || e) });
    }

    let rel;
    try {
      rel = sanitizeRelPath(dest);
    } catch {
      return res.status(400).json({ error: 'Invalid dest path' });
    }

    const objectName = `${prefix}${rel}`.replace(/\/+/, '/');

    // Prepare auth and issue upload
    const headers = await getAuthHeaders();
    const userProject = process.env.GCS_BILLING_PROJECT || process.env.BILLING_PROJECT || '';

    const contentType = contentTypeOverride || mimeFromForm || guessContentType(filename);

    // Optional content-type validation
    const allowed = parseAllowedTypes();
    if (allowed.length > 0) {
      const ok = allowed.some((p) => mimeMatches(p, contentType));
      if (!ok) {
        return res.status(415).json({ error: 'unsupported_media_type', contentType, allowed });
      }
    }

    const params = { uploadType: 'media', name: objectName };
    if (userProject) params.userProject = userProject;

    const url = `https://www.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`;

    // Axios will stream the body when given a Node stream
    const resp = await axios.post(url, fileStream, {
      params,
      headers: { ...headers, 'Content-Type': contentType },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 120000,
      validateStatus: (s) => s < 500,
    });

    if (resp.status !== 200) {
      return res.status(resp.status).json({ error: 'Upload failed', status: resp.status, details: resp.data });
    }

    const resource = resp.data || {};
    const location = `gs://${bucket}/${resource.name || objectName}`;
    res.set('Location', location);

    return res.status(201).json({
      ok: true,
      bucket,
      object: resource.name || objectName,
      generation: resource.generation || null,
      size: resource.size ? Number(resource.size) : null,
      contentType,
      md5Hash: resource.md5Hash || null,
      mediaLink: resource.mediaLink || null,
      selfLink: resource.selfLink || null,
      prefix,
      location,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[filesystem/upload] error', err);
    const msg = String(err?.message || err);
    const code = msg.includes('File too large') || msg.includes('entity too large') ? 413 : (msg === 'unsupported_media_type' ? 415 : 500);
    return res.status(code).json({ error: msg });
  }
});

export default router;
