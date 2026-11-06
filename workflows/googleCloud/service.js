import { createHash, randomBytes } from 'node:crypto';
import { getFirestore } from 'firebase-admin/firestore';
import { encryptString, decryptString } from '../crypto.js';

const CLOUD_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const STATE_LIFETIME_MS = 10 * 60 * 1000;
const cache = new Map();

const digest = text => createHash('sha256').update(text).digest('hex');
const callbackUrl = () => process.env.GOOGLE_CLOUD_OAUTH_CALLBACK_URL || 'https://api.awfl.us/google-cloud/callback';

export function googleCloudConfigured(env = process.env) {
  return Boolean(env.GOOGLE_CLOUD_OAUTH_CLIENT_ID && env.GOOGLE_CLOUD_OAUTH_CLIENT_SECRET && env.ENCRYPTION_SECRET_KEY);
}

function requireConfigured() {
  if (!googleCloudConfigured()) throw new Error('Google Cloud OAuth is not configured on the server');
}

function projectRef(db, userId, projectId) {
  if (typeof userId !== 'string' || !userId ||
    typeof projectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) {
    throw new Error('Invalid project');
  }
  return db.collection('users').doc(userId).collection('projects').doc(projectId);
}

function integrationRef(db, userId, projectId) {
  return projectRef(db, userId, projectId).collection('integrations').doc('googleCloud');
}

async function assertProject(db, userId, projectId) {
  const ref = projectRef(db, userId, projectId);
  if (!(await ref.get()).exists) throw new Error('Project not found');
  return ref;
}

export function googleCloudAuthUrl({ clientId, state, codeChallenge, redirectUri = callbackUrl() }) {
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email ' + CLOUD_SCOPE);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function googleCloudStatus({ userId, projectId, db = getFirestore() }) {
  await assertProject(db, userId, projectId);
  const snap = await integrationRef(db, userId, projectId).get();
  const data = snap.data();
  return {
    configured: googleCloudConfigured(),
    connected: Boolean(snap.exists),
    cloudProjectId: data?.cloudProjectId || null,
    email: data?.email || null,
    linkedAt: data?.linkedAt || null,
  };
}

export async function beginGoogleCloudOAuth({ userId, projectId, cloudProjectId, db = getFirestore() }) {
  requireConfigured();
  await assertProject(db, userId, projectId);
  // A Google Cloud project ID (not a numeric project number).
  if (typeof cloudProjectId !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(cloudProjectId)) {
    throw new Error('Enter a valid Google Cloud project ID');
  }
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const now = Date.now();
  await db.collection('googleCloudOAuthStates').doc(digest(state)).create({
    userId, projectId, cloudProjectId, verifier,
    expiresAt: now + STATE_LIFETIME_MS,
    expires_at: new Date(now + 60 * 60 * 1000),
  });
  return { url: googleCloudAuthUrl({
    clientId: process.env.GOOGLE_CLOUD_OAUTH_CLIENT_ID,
    state, codeChallenge: challenge,
  }) };
}

async function consumeState(state, db) {
  if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state)) throw new Error('Invalid authorization state');
  const ref = db.collection('googleCloudOAuthStates').doc(digest(state));
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().expiresAt < Date.now()) throw new Error('Authorization expired');
    tx.delete(ref);
    return snap.data();
  });
}

async function exchange(body, fetcher) {
  const response = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('Google Cloud token exchange failed');
  return response.json();
}

export async function finishGoogleCloudOAuth({ state, code, error, db = getFirestore(), fetcher = fetch }) {
  const pending = await consumeState(state, db);
  if (error) throw new Error('Google Cloud authorization denied');
  if (typeof code !== 'string' || code.length < 4 || code.length > 4096) throw new Error('Authorization code missing');
  requireConfigured();
  await assertProject(db, pending.userId, pending.projectId);
  const token = await exchange({
    code,
    client_id: process.env.GOOGLE_CLOUD_OAUTH_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLOUD_OAUTH_CLIENT_SECRET,
    redirect_uri: callbackUrl(),
    code_verifier: pending.verifier,
    grant_type: 'authorization_code',
  }, fetcher);
  if (typeof token.refresh_token !== 'string' || !token.refresh_token) {
    throw new Error('Offline access was not granted; reconnect and approve consent');
  }
  if (typeof token.scope === 'string' && !token.scope.split(' ').includes(CLOUD_SCOPE)) {
    throw new Error('Google Cloud access was not granted');
  }
  let email = null;
  if (token.access_token) {
    try {
      const response = await fetcher('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: 'Bearer ' + token.access_token },
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) {
        const profile = await response.json();
        if (typeof profile.email === 'string') email = profile.email;
      }
    } catch { /* Email is optional. Never log tokens. */ }
  }
  await integrationRef(db, pending.userId, pending.projectId).set({
    cloudProjectId: pending.cloudProjectId,
    email,
    refreshTokenEnc: encryptString(token.refresh_token),
    linkedAt: new Date().toISOString(),
  });
  cache.delete(pending.userId + ':' + pending.projectId);
  return { projectId: pending.projectId, result: 'connected' };
}

export async function resolveGoogleCloudAccessToken({ userId, projectId, db = getFirestore(), fetcher = fetch }) {
  if (!userId || !projectId) return null;
  const snap = await integrationRef(db, userId, projectId).get();
  if (!snap.exists) return null;
  requireConfigured();
  const data = snap.data();
  const key = userId + ':' + projectId;
  const cached = cache.get(key);
  if (cached && cached.linkedAt === data.linkedAt && cached.expiresAt > Date.now() + 5 * 60 * 1000) {
    return { accessToken: cached.token, cloudProjectId: data.cloudProjectId };
  }
  if (!data.refreshTokenEnc || !data.cloudProjectId) throw new Error('Invalid Google Cloud connection');
  const refreshed = await exchange({
    client_id: process.env.GOOGLE_CLOUD_OAUTH_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLOUD_OAUTH_CLIENT_SECRET,
    refresh_token: decryptString(data.refreshTokenEnc),
    grant_type: 'refresh_token',
  }, fetcher);
  if (!refreshed.access_token || !Number.isFinite(Number(refreshed.expires_in))) {
    throw new Error('Google Cloud connection needs to be reauthorized');
  }
  const expiresAt = Date.now() + Number(refreshed.expires_in) * 1000;
  cache.set(key, { token: refreshed.access_token, linkedAt: data.linkedAt, expiresAt });
  return { accessToken: refreshed.access_token, cloudProjectId: data.cloudProjectId };
}

export async function testGoogleCloud({ userId, projectId, db = getFirestore(), fetcher = fetch }) {
  await assertProject(db, userId, projectId);
  const auth = await resolveGoogleCloudAccessToken({ userId, projectId, db, fetcher });
  if (!auth) throw new Error('Google Cloud is not connected');
  // Only inspect whether the project is reachable; do not return secrets or names.
  const url = 'https://secretmanager.googleapis.com/v1/projects/' + encodeURIComponent(auth.cloudProjectId) + '/secrets?pageSize=1';
  const response = await fetcher(url, {
    headers: { Authorization: 'Bearer ' + auth.accessToken },
    signal: AbortSignal.timeout(15000),
  });
  return { cloudProjectId: auth.cloudProjectId,
    access: response.ok ? 'ok' : response.status === 403 ? 'permission_denied' : 'unavailable' };
}

export async function disconnectGoogleCloud({ userId, projectId, db = getFirestore(), fetcher = fetch }) {
  await assertProject(db, userId, projectId);
  const ref = integrationRef(db, userId, projectId);
  const snap = await ref.get();
  cache.delete(userId + ':' + projectId);
  // Removing the link must succeed even if Google's revoke endpoint is offline.
  // Never log or return the refresh token.
  if (snap.exists && snap.data()?.refreshTokenEnc) {
    try {
      await fetcher('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: decryptString(snap.data().refreshTokenEnc) }).toString(),
        signal: AbortSignal.timeout(10000),
      });
    } catch { /* Revocation best-effort; deletion is authoritative in AWFL. */ }
  }
  await ref.delete();
  return { ok: true };
}
