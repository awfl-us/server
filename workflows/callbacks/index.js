import express from 'express';
import axios from 'axios';
import { getFirestore } from 'firebase-admin/firestore';
import { projectScopedCollectionPath } from '../utils.js';
import { GoogleAuth } from 'google-auth-library';

const router = express.Router();
const db = getFirestore();
router.use(express.json({ limit: process.env.CALLBACK_MAX_BYTES || '1mb' }));

function isHttpUrl(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

async function buildForwardHeaders(req) {
  const h = {};
  const allow = ['content-type'];
  for (const k of allow) {
    const v = req.headers[k];
    if (v) h[k] = v;
  }

  h['x-callback-id'] = req.params.id;
  h['x-callback-project-id'] = req.projectId || '';

  // Add Authorization token for Google Workflows
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  h['authorization'] = `Bearer ${token.token || token}`; // .token in newer versions

  return h;
}

// Invoke a stored callback by id; pass the request body to the original callback_url
// Route supports POST for now; can expand to other verbs if needed.
router.post('/:id', async (req, res) => {
  const userId = req.userId;
  const projectId = req.projectId;
  const id = String(req.params.id || '').trim();

  if (!userId) return res.status(401).json({ error: 'Unauthorized: missing req.userId' });
  if (!projectId) return res.status(400).json({ error: 'Missing x-project-id header' });
  if (!id) return res.status(400).json({ error: 'Missing callback id' });

  try {
    const docPath = projectScopedCollectionPath(userId, projectId, `callbacks/${id}`);
    const ref = db.doc(docPath);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Callback not found' });

    const data = snap.data() || {};
    const url = data.callback_url;
    if (!isHttpUrl(url)) return res.status(400).json({ error: 'Stored callback_url is invalid' });

    const timeoutMs = Math.max(Number(process.env.CALLBACK_TIMEOUT_MS || 15000), 1000);

    let status = 500;
    let respBody = null;
    let lastError = null;

    try {
      const headers = await buildForwardHeaders(req);

      const resp = await axios.post(url, req.body, {
        headers,
        timeout: timeoutMs,
        validateStatus: () => true,
      });
      status = resp.status;
      respBody = resp.data;
      lastError = null;
    } catch (err) {
      status = err?.response?.status || 500;
      respBody = err?.response?.data || { error: String(err?.message || err) };
      lastError = String(err?.message || err);
    }

    const now = Date.now();
    try {
      await ref.update({
        called_at: now,
        last_status: status,
        last_error: lastError,
      });
    } catch (e) {
      // log and continue
      console.warn('[callbacks invoke] failed to persist call metadata', String(e?.message || e));
    }

    // Mirror the upstream status and payload
    return res.status(status).json(respBody);
  } catch (err) {
    console.error('[workflows/callbacks:invoke] error', err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

export default router;
