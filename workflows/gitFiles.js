// functions/services/gitFiles.js
// Service helpers and an Express router for interacting with
// GitHub repo files (list/read/write/delete) using the GitHub REST API.
// Default repo: github.com/dezmoanded/TopAigents
// Auth resolution: per-request from Firestore (scoped by req.userId + projectId),
//                  with env var fallback (GITHUB_TOKEN) when unauthenticated or missing.

import express from 'express';
import axios from 'axios';
import { getFirestore } from 'firebase-admin/firestore';
import { initializeApp, getApps } from 'firebase-admin/app';

// Ensure Firebase Admin initialized (no-op if already initialized by host)
if (!getApps().length) {
  try { initializeApp(); } catch (_) {}
}

const GITHUB_API = 'https://api.github.com';
const DEFAULT_OWNER = 'dezmoanded';
const DEFAULT_REPO = 'TopAigents';
const DEFAULT_BRANCH = 'main';

// --------------------
// Diagnostics logging (opt-in via LOG_GIT=1|true|yes|debug)
// --------------------
const LOG_GIT = /^(1|true|yes|debug)$/i.test(process.env.LOG_GIT || '');
function logGit(event, meta = {}) {
  if (!LOG_GIT) return;
  try {
    // Never log tokens; ensure common fields are safe
    const safe = { ...meta };
    if ('token' in safe) delete safe.token;
    if ('Authorization' in safe) delete safe.Authorization;
    // eslint-disable-next-line no-console
    console.log(`[git] ${event}`, safe);
  } catch {
    // swallow
  }
}

// --------------------
// Encoding helpers
// --------------------
function b64encode(strOrBuffer) {
  if (Buffer.isBuffer(strOrBuffer)) return strOrBuffer.toString('base64');
  return Buffer.from(String(strOrBuffer), 'utf8').toString('base64');
}

function b64decodeToUtf8(b64) {
  return Buffer.from(b64, 'base64').toString('utf8');
}

function encodePathSegments(path = '') {
  if (!path) return '';
  // Encode each segment but preserve '/'
  return path.split('/').map(encodeURIComponent).join('/');
}

// --------------------
// Firestore-backed GitHub config (per user/project)
// Path: users/{userId}/projects/{projectId}/integrations/github
// Stored fields: { owner, repo, token, defaultBranch, updatedAt }
// --------------------
async function loadGithubConfig(userId, projectId) {
  if (!userId || !projectId) return null;
  try {
    const db = getFirestore();
    const ref = db.doc(`users/${userId}/projects/${projectId}/integrations/github`);
    const snap = await ref.get();
    if (!snap.exists) return null;
    const data = snap.data() || {};
    return {
      owner: data.owner || DEFAULT_OWNER,
      repo: data.repo || DEFAULT_REPO,
      token: data.token || null,
      defaultBranch: data.defaultBranch || DEFAULT_BRANCH,
    };
  } catch (e) {
    // Firestore might be unavailable in some environments
    return null;
  }
}

async function saveGithubConfig(userId, projectId, { owner, repo, token, defaultBranch }) {
  if (!userId || !projectId) throw new Error('userId and projectId are required');
  const db = getFirestore();
  const ref = db.doc(`users/${userId}/projects/${projectId}/integrations/github`);
  const payload = {
    owner: owner || DEFAULT_OWNER,
    repo: repo || DEFAULT_REPO,
    defaultBranch: defaultBranch || DEFAULT_BRANCH,
    updatedAt: new Date().toISOString(),
  };
  if (typeof token === 'string') payload.token = token; // allow updating token
  await ref.set(payload, { merge: true });
  // Return masked response
  return { ...payload, hasToken: !!payload.token, token: undefined };
}

async function deleteGithubConfig(userId, projectId) {
  if (!userId || !projectId) throw new Error('userId and projectId are required');
  const db = getFirestore();
  const ref = db.doc(`users/${userId}/projects/${projectId}/integrations/github`);
  await ref.delete();
  return { ok: true };
}

// --------------------
// Auth header builder (token required)
// --------------------
function getAuthHeaders(token) {
  if (!token) {
    throw new Error('Missing GitHub token (none in Firestore and no GITHUB_TOKEN env var)');
  }
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'TopAigents-GitFiles-Service',
  };
}

// --------------------
// Core GitHub file helpers (owner/repo/token required)
// --------------------
export async function listRepoPath({ path = '', ref = DEFAULT_BRANCH, owner = DEFAULT_OWNER, repo = DEFAULT_REPO, token }) {
  const p = encodePathSegments(path);
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${p}` + (ref ? `?ref=${encodeURIComponent(ref)}` : '');
  logGit('gh.request', { op: 'listRepoPath', method: 'GET', url, owner, repo, ref, path });
  const resp = await axios.get(url, { headers: getAuthHeaders(token) });
  logGit('gh.response', { op: 'listRepoPath', status: resp.status, url });
  return resp.data; // GitHub returns array for dir, object for file
}

export async function readFile({ path, ref = DEFAULT_BRANCH, owner = DEFAULT_OWNER, repo = DEFAULT_REPO, token }) {
  if (!path) throw new Error('path is required');
  const p = encodePathSegments(path);
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${p}?ref=${encodeURIComponent(ref)}`;
  logGit('gh.request', { op: 'readFile', method: 'GET', url, owner, repo, ref, path });
  const resp = await axios.get(url, { headers: getAuthHeaders(token) });
  logGit('gh.response', { op: 'readFile', status: resp.status, url });
  const data = resp.data;
  if (!data.content || data.encoding !== 'base64') {
    return { path: data.path, sha: data.sha, encoding: data.encoding, content: null };
  }
  return {
    path: data.path,
    sha: data.sha,
    encoding: 'utf-8',
    content: b64decodeToUtf8(data.content),
  };
}

export async function writeFile({ path, content, message, branch = DEFAULT_BRANCH, sha, owner = DEFAULT_OWNER, repo = DEFAULT_REPO, token }) {
  if (!path) throw new Error('path is required');
  if (typeof content === 'undefined') throw new Error('content is required');
  const p = encodePathSegments(path);
  const putUrl = `${GITHUB_API}/repos/${owner}/${repo}/contents/${p}`;

  let effectiveSha = sha;
  if (!effectiveSha) {
    const headUrl = `${putUrl}?ref=${encodeURIComponent(branch)}`;
    try {
      logGit('gh.request', { op: 'writeFile.head', method: 'GET', url: headUrl, owner, repo, branch, path });
      const headResp = await axios.get(headUrl, { headers: getAuthHeaders(token) });
      logGit('gh.response', { op: 'writeFile.head', status: headResp.status, url: headUrl });
      effectiveSha = headResp.data.sha;
    } catch (e) {
      const status = e?.response?.status;
      logGit('gh.error', { op: 'writeFile.head', status, url: headUrl, message: e?.message });
      // If 404, it's a new file; continue without sha
      if (!(status === 404)) throw e;
    }
  }

  const body = {
    message: message || `chore: write ${path}`,
    content: b64encode(content),
    branch,
    ...(effectiveSha ? { sha: effectiveSha } : {}),
  };

  logGit('gh.request', { op: 'writeFile.put', method: 'PUT', url: putUrl, owner, repo, branch, path, hasSha: !!effectiveSha });
  const resp = await axios.put(putUrl, body, { headers: getAuthHeaders(token) });
  logGit('gh.response', { op: 'writeFile.put', status: resp.status, url: putUrl });
  return resp.data; // includes content + commit
}

export async function deleteFile({ path, message, branch = DEFAULT_BRANCH, sha, owner = DEFAULT_OWNER, repo = DEFAULT_REPO, token }) {
  if (!path) throw new Error('path is required');
  const p = encodePathSegments(path);
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${p}`;

  let effectiveSha = sha;
  if (!effectiveSha) {
    const headUrl = `${url}?ref=${encodeURIComponent(branch)}`;
    logGit('gh.request', { op: 'deleteFile.head', method: 'GET', url: headUrl, owner, repo, branch, path });
    const headResp = await axios.get(headUrl, { headers: getAuthHeaders(token) });
    logGit('gh.response', { op: 'deleteFile.head', status: headResp.status, url: headUrl });
    effectiveSha = headResp.data.sha;
  }

  const body = {
    message: message || `chore: delete ${path}`,
    sha: effectiveSha,
    branch,
  };

  logGit('gh.request', { op: 'deleteFile', method: 'DELETE', url, owner, repo, branch, path, hasSha: !!effectiveSha });
  const resp = await axios.delete(url, { headers: getAuthHeaders(token), data: body });
  logGit('gh.response', { op: 'deleteFile', status: resp.status, url });
  return resp.data; // includes commit
}

export async function getTree({ ref = DEFAULT_BRANCH, recursive = true, owner = DEFAULT_OWNER, repo = DEFAULT_REPO, token }) {
  // Step 1: resolve ref -> commit SHA
  const refUrl = `${GITHUB_API}/repos/${owner}/${repo}/git/ref/${ref.startsWith('heads/') || ref.startsWith('tags/') ? '' : 'heads/'}${encodeURIComponent(ref)}`;
  logGit('gh.request', { op: 'getTree.ref', method: 'GET', url: refUrl, owner, repo, ref, recursive });
  const refResp = await axios.get(refUrl, { headers: getAuthHeaders(token) });
  logGit('gh.response', { op: 'getTree.ref', status: refResp.status, url: refUrl });
  const commitSha = refResp.data.object?.sha || refResp.data.sha;

  // Step 2: commit -> tree SHA
  const commitUrl = `${GITHUB_API}/repos/${owner}/${repo}/git/commits/${commitSha}`;
  logGit('gh.request', { op: 'getTree.commit', method: 'GET', url: commitUrl, owner, repo });
  const commitResp = await axios.get(commitUrl, { headers: getAuthHeaders(token) });
  logGit('gh.response', { op: 'getTree.commit', status: commitResp.status, url: commitUrl });
  const treeSha = commitResp.data.tree?.sha;

  // Step 3: tree
  const treeUrl = `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${treeSha}${recursive ? '?recursive=1' : ''}`;
  logGit('gh.request', { op: 'getTree.tree', method: 'GET', url: treeUrl, owner, repo, recursive });
  const resp = await axios.get(treeUrl, { headers: getAuthHeaders(token) });
  logGit('gh.response', { op: 'getTree.tree', status: resp.status, url: treeUrl });
  return resp.data; // { sha, tree: [{ path, type, sha, size }], truncated }
}

// --------------------
// Per-request config resolver
// --------------------
async function resolveRequestConfig(req) {
  // Project can be provided via query, body, or header
  const projectId = req.query?.projectId || req.body?.projectId || req.headers['x-project-id'];
  let cfg = null;
  if (req.userId && projectId) {
    cfg = await loadGithubConfig(String(req.userId), String(projectId));
  }

  // Fallback to env token and defaults
  const envToken = process.env.GITHUB_TOKEN || null;
  const resolved = {
    owner: cfg?.owner || DEFAULT_OWNER,
    repo: cfg?.repo || DEFAULT_REPO,
    token: cfg?.token || envToken,
    defaultBranch: cfg?.defaultBranch || DEFAULT_BRANCH,
    projectId: projectId || null,
    hasUserScopedToken: !!cfg?.token,
  };
  const tokenSource = cfg?.token ? 'firestore' : envToken ? 'env' : 'none';
  logGit('config.resolve', {
    userIdPresent: !!req.userId,
    projectId: resolved.projectId,
    tokenSource,
    owner: resolved.owner,
    repo: resolved.repo,
    defaultBranch: resolved.defaultBranch,
  });
  return resolved;
}

// --------------------
// Express router
// --------------------
export const gitFilesRouter = express.Router();

function safeHandler(fn) {
  return async (req, res) => {
    const routeInfo = {
      method: req.method,
      path: req.originalUrl || req.url,
      userIdPresent: !!req.userId,
      projectId: req.query?.projectId || req.body?.projectId || req.headers['x-project-id'] || null,
    };
    try {
      logGit('route.enter', routeInfo);
      const result = await fn(req, res);
      logGit('route.success', routeInfo);
      res.json(result);
    } catch (err) {
      const status = err.response?.status || (String(err.message || '').includes('Missing GitHub token') ? 400 : 500);
      logGit('route.error', {
        ...routeInfo,
        status,
        ghStatus: err.response?.status,
        ghMessage: err.response?.data?.message,
        error: err.message,
      });
      res.status(status).json({ error: err.message, details: err.response?.data });
    }
  };
}

// ---- Config management (requires req.userId) ----
// GET /config?projectId=
// Returns masked config: { owner, repo, defaultBranch, hasToken }
gitFilesRouter.get('/config', safeHandler(async (req) => {
  const userId = req.userId;
  const projectId = req.query?.projectId || req.headers['x-project-id'];
  if (!userId) throw new Error('Unauthorized: missing userId');
  if (!projectId) throw new Error('projectId is required');
  const cfg = await loadGithubConfig(String(userId), String(projectId));
  return cfg ? { owner: cfg.owner, repo: cfg.repo, defaultBranch: cfg.defaultBranch, hasToken: !!cfg.token } : { owner: DEFAULT_OWNER, repo: DEFAULT_REPO, defaultBranch: DEFAULT_BRANCH, hasToken: false };
}));

// PUT /config { projectId, owner?, repo?, token?, defaultBranch? }
// Saves config; responds with masked snapshot
gitFilesRouter.put('/config', safeHandler(async (req) => {
  const userId = req.userId;
  const { projectId, owner, repo, token, defaultBranch } = req.body || {};
  if (!userId) throw new Error('Unauthorized: missing userId');
  if (!projectId) throw new Error('projectId is required');
  return saveGithubConfig(String(userId), String(projectId), { owner, repo, token, defaultBranch });
}));

// DELETE /config?projectId=
// Deletes stored config
gitFilesRouter.delete('/config', safeHandler(async (req) => {
  const userId = req.userId;
  const projectId = req.query?.projectId || req.body?.projectId || req.headers['x-project-id'];
  if (!userId) throw new Error('Unauthorized: missing userId');
  if (!projectId) throw new Error('projectId is required');
  return deleteGithubConfig(String(userId), String(projectId));
}));

// ---- GitHub file operations ----
// GET /list?path=&ref=&projectId=
gitFilesRouter.get('/list', safeHandler(async (req) => {
  const { path = '', ref } = req.query;
  const cfg = await resolveRequestConfig(req);
  return listRepoPath({ path, ref: ref || cfg.defaultBranch, owner: cfg.owner, repo: cfg.repo, token: cfg.token });
}));

// GET /read?path=&ref=&projectId=
gitFilesRouter.get('/read', safeHandler(async (req) => {
  const { path, ref } = req.query;
  if (!path) throw new Error('path is required');
  const cfg = await resolveRequestConfig(req);
  return readFile({ path, ref: ref || cfg.defaultBranch, owner: cfg.owner, repo: cfg.repo, token: cfg.token });
}));

// PUT /write { path, content, message, branch?, sha?, projectId }
gitFilesRouter.put('/write', safeHandler(async (req) => {
  const { path, content, message, branch, sha } = req.body || {};
  const cfg = await resolveRequestConfig(req);
  return writeFile({ path, content, message, branch: branch || cfg.defaultBranch, sha, owner: cfg.owner, repo: cfg.repo, token: cfg.token });
}));

// DELETE /delete { path, message?, branch?, sha?, projectId }
// Note: using body for DELETE to pass message/sha.
gitFilesRouter.delete('/delete', safeHandler(async (req) => {
  const { path, message, branch, sha } = req.body || {};
  const cfg = await resolveRequestConfig(req);
  return deleteFile({ path, message, branch: branch || cfg.defaultBranch, sha, owner: cfg.owner, repo: cfg.repo, token: cfg.token });
}));

// GET /tree?ref=&recursive=1&projectId=
gitFilesRouter.get('/tree', safeHandler(async (req) => {
  const { ref, recursive } = req.query;
  const rec = recursive === undefined ? true : ['1', 'true', 'yes'].includes(String(recursive).toLowerCase());
  const cfg = await resolveRequestConfig(req);
  return getTree({ ref: ref || cfg.defaultBranch, recursive: rec, owner: cfg.owner, repo: cfg.repo, token: cfg.token });
}));

export default gitFilesRouter;
