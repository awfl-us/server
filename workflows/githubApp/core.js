import { createPrivateKey, sign, randomBytes } from 'node:crypto';

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

export function parseGithubRemote(remote) {
  if (typeof remote !== 'string') return null;
  const normalized = remote.trim()
    .replace(/^git@github\.com:/i, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//i, 'https://github.com/')
    .replace(/^github\.com\//i, 'https://github.com/');
  let url;
  try { url = new URL(normalized); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== 'github.com' ||
      url.username || url.password || url.port || url.search || url.hash) return null;
  const parts = url.pathname.replace(/^\//, '').replace(/\/$/, '').split('/');
  if (parts.length !== 2 || !SEGMENT.test(parts[0])) return null;
  const repo = parts[1].replace(/\.git$/i, '');
  if (!repo || !SEGMENT.test(repo)) return null;
  return { owner: parts[0], repo, fullName: parts[0] + '/' + repo };
}

export function githubAppConfigured(env = process.env) {
  return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_CLIENT_ID &&
    env.GITHUB_APP_CLIENT_SECRET && env.GITHUB_APP_PRIVATE_KEY_B64 && env.GITHUB_APP_SLUG);
}

export function githubAppInstallUrl(env = process.env) {
  const slug = env.GITHUB_APP_SLUG;
  return typeof slug === 'string' && /^[a-z0-9-]+$/.test(slug)
    ? 'https://github.com/apps/' + slug + '/installations/new' : null;
}

export function appJwt({ appId, privateKeyB64, nowSeconds = Math.floor(Date.now() / 1000) }) {
  if (!/^\d+$/.test(String(appId))) throw new Error('GitHub App ID not configured');
  const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encoded({ alg: 'RS256', typ: 'JWT' });
  const payload = encoded({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: String(appId) });
  const signingInput = header + '.' + payload;
  const pem = Buffer.from(privateKeyB64, 'base64').toString('utf8');
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), createPrivateKey(pem)).toString('base64url');
  return signingInput + '.' + signature;
}

export function oauthAuthorizeUrl({ clientId, callbackUrl, state }) {
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', callbackUrl);
  url.searchParams.set('state', state);
  return url.toString();
}

export function newOAuthState() {
  return randomBytes(32).toString('base64url');
}
