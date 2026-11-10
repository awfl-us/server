import { getFirestore } from 'firebase-admin/firestore';
import { appJwt, githubAppConfigured, githubAppInstallUrl, oauthAuthorizeUrl, parseGithubRemote, newOAuthState } from './core.js';
import { createHash } from 'node:crypto';

const API = 'https://api.github.com';
const MAX_PAGES = 10;
const tokenCache = new Map();
const digest = s => createHash('sha256').update(s).digest('hex');
const headers = token => ({
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2026-03-10',
  Authorization: 'Bearer ' + token,
  'User-Agent': 'awfl-github-app',
});

function projectRef(db, uid, projectId) {
  if (typeof uid !== 'string' || !uid ||
    typeof projectId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(projectId)) {
    throw new Error('Invalid project');
  }
  return db.collection('users').doc(uid).collection('projects').doc(projectId);
}

function linkRef(db, uid, projectId) {
  return projectRef(db, uid, projectId).collection('integrations').doc('githubApp');
}

async function githubRequest(path, token, { method = 'GET', body, fetcher = fetch } = {}) {
  const response = await fetcher(API + path, {
    method,
    headers: { ...headers(token), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    // Never include token or response body in errors.
    throw new Error('GitHub API request failed (' + response.status + ')');
  }
  return response.json();
}

export async function getGithubAppStatus({ userId, projectId, db = getFirestore() }) {
  const project = await projectRef(db, userId, projectId).get();
  if (!project.exists) throw new Error('Project not found');
  const parsed = parseGithubRemote(project.data()?.remote);
  const linked = await linkRef(db, userId, projectId).get();
  const data = linked.data();
  return {
    configured: githubAppConfigured(),
    connected: Boolean(linked.exists),
    repository: data?.repoFullName || null,
    remoteRepository: parsed?.fullName || null,
    installationUrl: githubAppInstallUrl(),
    needsReconnect: Boolean(linked.exists && parsed &&
      parsed.fullName.toLowerCase() !== String(data?.repoFullName || '').toLowerCase()),
  };
}

export async function beginGithubAppOAuth({ userId, projectId, db = getFirestore() }) {
  if (!githubAppConfigured()) throw new Error('GitHub App not configured');
  const project = await projectRef(db, userId, projectId).get();
  if (!project.exists) throw new Error('Project not found');
  const remote = parseGithubRemote(project.data()?.remote);
  if (!remote) throw new Error('Set a GitHub repository URL in the project first');

  const state = newOAuthState();
  const now = Date.now();
  await db.collection('githubAppOAuthStates').doc(digest(state)).create({
    userId, projectId, remoteFullName: remote.fullName,
    expiresAt: now + 10 * 60 * 1000,
    expires_at: new Date(now + 60 * 60 * 1000),
  });
  return { url: oauthAuthorizeUrl({
    clientId: process.env.GITHUB_APP_CLIENT_ID,
    callbackUrl: process.env.GITHUB_APP_CALLBACK_URL || 'https://api.awfl.us/github-app/callback',
    state,
  }) };
}

async function consumeState(state, db) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state || '')) throw new Error('Invalid authorization state');
  const ref = db.collection('githubAppOAuthStates').doc(digest(state));
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().expiresAt <= Date.now()) throw new Error('Authorization expired');
    tx.delete(ref); // one-time use, including failed authorizations
    return snap.data();
  });
}

async function oauthToken(code, { fetcher = fetch } = {}) {
  const response = await fetcher('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GITHUB_APP_CLIENT_ID,
      client_secret: process.env.GITHUB_APP_CLIENT_SECRET,
      redirect_uri: process.env.GITHUB_APP_CALLBACK_URL || 'https://api.awfl.us/github-app/callback',
      code,
    }).toString(),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('GitHub authorization exchange failed');
  const data = await response.json();
  if (!data.access_token || data.error) throw new Error('GitHub authorization denied');
  return data.access_token; // not persisted, logged or exposed to the browser
}

async function findAccessibleInstallation(userToken, targetFullName, { fetcher = fetch } = {}) {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await githubRequest('/user/installations?per_page=100&page=' + page, userToken, { fetcher });
    const installations = result.installations || [];
    for (const installation of installations) {
      if (installation.app_id !== Number(process.env.GITHUB_APP_ID) ||
        installation.suspended_at ||
        installation.account?.login?.toLowerCase() !== targetFullName.split('/')[0].toLowerCase()) continue;
      for (let reposPage = 1; reposPage <= MAX_PAGES; reposPage++) {
        const repos = await githubRequest('/user/installations/' + installation.id +
          '/repositories?per_page=100&page=' + reposPage, userToken, { fetcher });
        const match = (repos.repositories || []).find(r => r.full_name?.toLowerCase() === targetFullName.toLowerCase());
        // Installation tokens can write as the app. Do not let a read-only
        // collaborator link an installation with greater privileges.
        if (match && (match.permissions?.push === true || match.permissions?.admin === true)) return { installationId: installation.id, repositoryId: match.id,
          fullName: match.full_name, owner: match.owner.login, repo: match.name,
          defaultBranch: match.default_branch || 'main' };
        if ((repos.repositories || []).length < 100) break;
      }
    }
    if (installations.length < 100) break;
  }
  return null;
}

export async function finishGithubAppOAuth({ state, code, db = getFirestore(), fetcher = fetch }) {
  const pending = await consumeState(state, db);
  if (!/^[A-Za-z0-9_-]{4,256}$/.test(code || '')) throw new Error('Authorization code missing');
  const project = await projectRef(db, pending.userId, pending.projectId).get();
  const remote = parseGithubRemote(project.data()?.remote);
  if (!project.exists || remote?.fullName.toLowerCase() !== pending.remoteFullName.toLowerCase()) {
    throw new Error('Project repository changed during authorization');
  }
  const userToken = await oauthToken(code, { fetcher });
  const installation = await findAccessibleInstallation(userToken, pending.remoteFullName, { fetcher });
  if (!installation) return { projectId: pending.projectId, result: 'install_required' };

  await linkRef(db, pending.userId, pending.projectId).set({
    installationId: installation.installationId,
    repositoryId: installation.repositoryId,
    repoFullName: installation.fullName,
    owner: installation.owner,
    repo: installation.repo,
    defaultBranch: installation.defaultBranch,
    linkedAt: new Date().toISOString(),
  });
  return { projectId: pending.projectId, result: 'connected' };
}

export async function disconnectGithubApp({ userId, projectId, db = getFirestore() }) {
  const project = await projectRef(db, userId, projectId).get();
  if (!project.exists) throw new Error('Project not found');
  await linkRef(db, userId, projectId).delete();
  // This removes AWFL's association, not the actual GitHub App installation.
  return { ok: true };
}

export async function resolveGithubAppCredential({ userId, projectId, db = getFirestore(), fetcher = fetch }) {
  if (!userId || !projectId) return null;
  const snap = await linkRef(db, userId, projectId).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (!githubAppConfigured() || !Number.isSafeInteger(data.installationId) ||
    !Number.isSafeInteger(data.repositoryId) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(data.repoFullName || '')) {
    throw new Error('GitHub App installation is unavailable');
  }
  const project = await projectRef(db, userId, projectId).get();
  const remote = parseGithubRemote(project.data()?.remote);
  if (!project.exists || remote?.fullName.toLowerCase() !== data.repoFullName.toLowerCase()) {
    throw new Error('GitHub App repository no longer matches project remote');
  }
  // Installation tokens can cover all repositories authorized for this app
  // installation. Cloud workflows often need sibling repositories.
  const key = String(data.installationId);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 3 * 60 * 1000) {
    return { token: cached.token, owner: data.owner, repo: data.repo, defaultBranch: data.defaultBranch };
  }
  const jwt = appJwt({ appId: process.env.GITHUB_APP_ID, privateKeyB64: process.env.GITHUB_APP_PRIVATE_KEY_B64 });
  const result = await githubRequest('/app/installations/' + data.installationId + '/access_tokens',
    jwt, { method: 'POST', fetcher });
  if (!result.token || !result.expires_at) throw new Error('GitHub App token response invalid');
  tokenCache.set(key, { token: result.token, expiresAt: Date.parse(result.expires_at) });
  return { token: result.token, owner: data.owner, repo: data.repo, defaultBranch: data.defaultBranch };
}
