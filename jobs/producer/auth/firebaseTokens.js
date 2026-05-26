import admin from 'firebase-admin';
import axios from 'axios';

let tokenApp = null; // dedicated app for token minting to avoid conflicts with any global init
let pathLogged = false;

function normalizePk(rawPk) {
  if (!rawPk) return '';
  // Allow both escaped (\n) and real newlines
  const s = String(rawPk);
  return s.includes('\\n') ? s.replace(/\\n/g, '\n') : s;
}

function readExplicitCreds() {
  // Prefer explicit SA creds via env (local/dev-friendly)
  // Support both FIREBASE_* and GOOGLE_* aliases
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || process.env.GOOGLE_CLIENT_EMAIL || '';
  const rawPk = process.env.FIREBASE_PRIVATE_KEY || process.env.GOOGLE_PRIVATE_KEY || '';
  const privateKey = normalizePk(rawPk);

  // Optional: full JSON via FIREBASE_CREDENTIALS_JSON or base64 variant
  let jsonStr = process.env.FIREBASE_CREDENTIALS_JSON || '';
  if (!jsonStr && process.env.FIREBASE_CREDENTIALS_JSON_B64) {
    try { jsonStr = Buffer.from(process.env.FIREBASE_CREDENTIALS_JSON_B64, 'base64').toString('utf8'); } catch {}
  }
  if (jsonStr) {
    try {
      const parsed = JSON.parse(jsonStr);
      return {
        from: 'json',
        clientEmail: parsed.client_email,
        privateKey: normalizePk(parsed.private_key),
        projectId: parsed.project_id,
      };
    } catch {}
  }

  if (clientEmail && privateKey) {
    return { from: 'env', clientEmail, privateKey, projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT };
  }
  return null;
}

function getTokenApp() {
  if (tokenApp) return tokenApp;

  const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || undefined;
  const explicit = readExplicitCreds();

  try {
    if (explicit?.clientEmail && explicit?.privateKey) {
      // Use a dedicated named app so we don't depend on global initialization elsewhere
      tokenApp = admin.initializeApp({
        credential: admin.credential.cert({ clientEmail: explicit.clientEmail, privateKey: explicit.privateKey, projectId: explicit.projectId || projectId }),
        projectId: explicit.projectId || projectId,
      }, 'awfl-tokens');
      if (!pathLogged) { console.info('[firebaseTokens] using explicit private key for token minting'); pathLogged = true; }
    } else {
      tokenApp = admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        projectId,
      }, 'awfl-tokens');
      if (!pathLogged) { console.info('[firebaseTokens] using ADC for token minting'); pathLogged = true; }
    }
  } catch (e) {
    // If the named app already exists, reuse it
    if (String(e?.message || e).includes('already exists')) {
      tokenApp = admin.app('awfl-tokens');
    } else {
      throw e;
    }
  }

  return tokenApp;
}

export async function mintUserTokens({ uid }) {
  if (!uid) throw new Error('mintUserTokens: missing uid');
  if (String(uid).length > 128) throw new Error('mintUserTokens: uid too long (>128 chars)');

  const app = getTokenApp();

  // Create a Firebase Custom Token for the user
  const customToken = await app.auth().createCustomToken(String(uid));

  // Optionally exchange for an ID token via Identity Toolkit if API key is provided
  const apiKey = process.env.FIREBASE_API_KEY || '';
  let idToken = '';
  if (apiKey) {
    try {
      const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(apiKey)}`;
      const resp = await axios.post(url, { token: customToken, returnSecureToken: true }, { timeout: 10000 });
      idToken = String(resp?.data?.idToken || '');
    } catch (e) {
      // Do not fail the request; fallback to providing only the custom token
      console.warn('[firebaseTokens] ID token exchange failed; continuing with custom token only');
    }
  } else {
    // Make it explicit in logs that only a custom token will be available
    try { console.info('[firebaseTokens] FIREBASE_API_KEY not set; only FIREBASE_CUSTOM_TOKEN will be provided'); } catch {}
  }

  return { idToken, customToken };
}
