import express from 'express';
import { getFirestore } from 'firebase-admin/firestore';
import admin from 'firebase-admin';
import {
  OAUTH_ISSUER, API_RESOURCE, MCP_RESOURCES, normalizeResource, OAUTH_SCOPE, ACCESS_TTL_SECONDS,
  CODE_TTL_MS, CONSENT_TTL_MS, REFRESH_TTL_MS,
  randomToken, hashToken, pkceChallenge, mintAccessToken,
  isValidChatGptRedirect, callbackUrl,
} from './core.js';

const nowMs = () => Date.now();
const error = (res, status, code, description) =>
  res.status(status).set('Cache-Control', 'no-store').json({
    error: code, error_description: description,
  });
const metadata = () => ({
  resource: API_RESOURCE, authorization_servers: [OAUTH_ISSUER],
  scopes_supported: [OAUTH_SCOPE],
  resource_documentation: 'https://github.com/awfl-us/server/tree/main/mcp',
});
const authorizerMetadata = {
  issuer: OAUTH_ISSUER,
  authorization_response_iss_parameter_supported: true,
  authorization_endpoint: OAUTH_ISSUER + '/oauth/authorize',
  token_endpoint: OAUTH_ISSUER + '/oauth/token',
  registration_endpoint: OAUTH_ISSUER + '/oauth/register',
  client_id_metadata_document_supported: true,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['none'],
  code_challenge_methods_supported: ['S256'],
  scopes_supported: [OAUTH_SCOPE],
  service_documentation: 'https://github.com/awfl-us/server/tree/main/mcp',
};
const single = value => typeof value === 'string' ? value : '';
const okResource = value => !!normalizeResource(value);
const validVerifier = value => /^[A-Za-z0-9._~-]{43,128}$/.test(value || '');
const validChallenge = value => /^[A-Za-z0-9_-]{43}$/.test(value || '');
const E = (name, status = 400) => Object.assign(new Error(name), { oauthError: name, status });

async function authenticateWebUser(req, verifyFirebaseToken) {
  const token = /^Bearer (\S+)$/.exec(req.get('Authorization') || '')?.[1];
  if (!token) throw E('unauthorized', 401);
  const identity = await verifyFirebaseToken(token);
  const uid = identity?.uid;
  if (!uid) throw E('unauthorized', 401);
  return uid;
}
const CHATGPT_CIMD = /^https:\/\/chatgpt\.com\/oauth\/(?:client\.json|[A-Za-z0-9_-]{8,128}\/client\.json)$/;
const clientsCache = new Map();
async function resolveClient(db, clientId, redirect) {
  if (!clientId || clientId.length > 256) throw E('invalid_client');
  let client;
  if (CHATGPT_CIMD.test(clientId)) {
    const cached = clientsCache.get(clientId);
    if (cached && cached.expiresAt > Date.now()) client = cached.metadata;
    else {
      // ChatGPT controls this fixed HTTPS origin; do not fetch arbitrary client URLs.
      const response = await fetch(clientId, {
        redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { Accept: 'application/json' },
      });
      if (!response.ok || Number(response.headers.get('content-length') || 0) > 32768) throw E('invalid_client');
      const source = await response.text();
      if (source.length > 32768) throw E('invalid_client');
      client = JSON.parse(source);
      const methods = client.token_endpoint_auth_methods_supported ||
        [client.token_endpoint_auth_method];
      if (client.client_id !== clientId || !methods.includes('none') ||
          !Array.isArray(client.redirect_uris) ||
          !client.redirect_uris.every(isValidChatGptRedirect)) throw E('invalid_client');
      clientsCache.set(clientId, { metadata: client, expiresAt: Date.now() + 300000 });
    }
  } else {
    const snap = await db.collection('mcpOAuthClients').doc(clientId).get();
    client = snap.exists ? snap.data() : null;
  }
  if (!client || (redirect && (!client.redirect_uris.includes(redirect) ||
      !isValidChatGptRedirect(redirect)))) {
    throw E('invalid_client');
  }
  return client;
}

export function createMcpOAuthRouter({
  db = getFirestore(),
  verifyFirebaseToken = token => admin.auth().verifyIdToken(token),
  clock = nowMs,
} = {}) {
  const router = express.Router();
  router.get('/.well-known/oauth-protected-resource', (_req, res) =>
    res.json(metadata(MCP_RESOURCES.terminal)));
  router.get('/.well-known/oauth-protected-resource/mcp', (_req, res) =>
    res.json(metadata(MCP_RESOURCES.terminal)));
  router.get('/.well-known/oauth-protected-resource/mcp/agents', (_req, res) =>
    res.json(metadata(MCP_RESOURCES.agents)));
  router.get('/.well-known/oauth-authorization-server', (_req, res) =>
    res.json(authorizerMetadata));

  // DCR accepts public clients only, with an exact ChatGPT callback allowlist.
  // No client secret is issued or stored. The authorization-code flow requires PKCE.
  router.post('/oauth/register', async (req, res) => {
    const body = req.body || {};
    if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== 'none') {
      return error(res, 400, 'invalid_client_metadata', 'Only PKCE public clients are supported');
    }
    const redirects = body.redirect_uris;
    if (!Array.isArray(redirects) || redirects.length < 1 || redirects.length > 2 ||
        !redirects.every(isValidChatGptRedirect) ||
        (body.grant_types && !body.grant_types.includes('authorization_code')) ||
        (body.response_types && !body.response_types.includes('code'))) {
      return error(res, 400, 'invalid_client_metadata', 'Expected ChatGPT OAuth redirect URI');
    }
    const clientId = 'awfl-mcp-' + randomToken();
    const data = {
      client_id: clientId, redirect_uris: redirects,
      token_endpoint_auth_method: 'none',
      client_name: 'ChatGPT', createdAt: clock(),
    };
    try {
      await db.collection('mcpOAuthClients').doc(clientId).create(data);
      return res.status(201).set('Cache-Control', 'no-store').json({
        ...data, grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'], scope: OAUTH_SCOPE,
      });
    } catch {
      return error(res, 503, 'temporarily_unavailable', 'Registration unavailable');
    }
  });

  router.get('/oauth/authorize', async (req, res) => {
    const q = req.query || {};
    const clientId = single(q.client_id);
    const redirect = single(q.redirect_uri);
    let client;
    try {
      client = await resolveClient(db, clientId, redirect);
    } catch {
      // Do not redirect to an unverified redirect_uri.
      return error(res, 400, 'invalid_client', 'Unregistered OAuth client or callback');
    }
    const state = single(q.state);
    const resource = single(q.resource);
    const scopes = single(q.scope) || OAUTH_SCOPE;
    const challenge = single(q.code_challenge);
    if (q.response_type !== 'code' || !okResource(resource) || scopes !== OAUTH_SCOPE ||
        q.code_challenge_method !== 'S256' || !validChallenge(challenge) ||
        !state || state.length > 2048) {
      return res.redirect(302, callbackUrl(redirect, {
        error: 'invalid_request', error_description: 'Invalid resource, scope or PKCE request', state,
      }));
    }
    try {
      const requestId = randomToken();
      await db.collection('mcpOAuthRequests').doc(hashToken(requestId)).create({
        clientId, redirect, state, challenge,
        resource: API_RESOURCE, requestedResource: resource, scopes,
        expiresAtMs: clock() + CONSENT_TTL_MS,
      });
      return res.redirect(302,
        'https://awfl.us/oauth/consent?request=' + encodeURIComponent(requestId));
    } catch {
      return res.redirect(302, callbackUrl(redirect, {
        error: 'server_error', state,
      }));
    }
  });

  // The consent page uses the existing AWFL Google/Firebase sign-in. No OAuth
  // credentials are placed in the browser or submitted by unauthenticated users.
  router.get('/oauth/requests/:id', async (req, res) => {
    try {
      await authenticateWebUser(req, verifyFirebaseToken);
      const id = single(req.params.id);
      const snap = await db.collection('mcpOAuthRequests').doc(hashToken(id)).get();
      const request = snap.exists ? snap.data() : null;
      if (!request || request.expiresAtMs <= clock()) return error(res, 404, 'invalid_request', 'Authorization request expired');
      return res.set('Cache-Control', 'no-store').json({
        client_name: 'ChatGPT', resource: request.requestedResource, scope: request.scopes,
      });
    } catch (err) {
      return error(res, err.status || 401, err.oauthError || 'unauthorized', 'AWFL sign-in required');
    }
  });

  router.post('/oauth/decide', async (req, res) => {
    let uid;
    try {
      uid = await authenticateWebUser(req, verifyFirebaseToken);
    } catch (err) {
      return error(res, err.status || 401, err.oauthError || 'unauthorized', 'AWFL sign-in required');
    }
    const requestId = single(req.body?.request_id);
    if (!/^[A-Za-z0-9_-]{43}$/.test(requestId) || typeof req.body?.approve !== 'boolean') {
      return error(res, 400, 'invalid_request', 'Invalid approval request');
    }
    const requestRef = db.collection('mcpOAuthRequests').doc(hashToken(requestId));
    const code = randomToken();
    const codeRef = db.collection('mcpOAuthCodes').doc(hashToken(code));
    try {
      const request = await db.runTransaction(async tx => {
        const snap = await tx.get(requestRef);
        const item = snap.exists ? snap.data() : null;
        if (!item || item.expiresAtMs <= clock()) throw E('invalid_request');
        tx.delete(requestRef);
        if (req.body.approve) tx.create(codeRef, {
          ...item, userId: uid, expiresAtMs: clock() + CODE_TTL_MS,
        });
        return item;
      });
      return res.set('Cache-Control', 'no-store').json({
        redirect_url: callbackUrl(request.redirect, req.body.approve
          ? { code, state: request.state }
          : { error: 'access_denied', state: request.state }),
      });
    } catch {
      return error(res, 400, 'invalid_request', 'Authorization request used or expired');
    }
  });

  router.post('/oauth/token', express.urlencoded({ extended: false, limit: '16kb' }), async (req, res) => {
    const body = req.body || {};
    const clientId = single(body.client_id);
    const grant = single(body.grant_type);
    if (!clientId || !['authorization_code', 'refresh_token'].includes(grant)) {
      return error(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token');
    }
    try {
      const client = await resolveClient(db, clientId, grant === 'authorization_code'
        ? single(body.redirect_uri) : null);
      let authorization;
      const refreshToken = randomToken();
      const refreshRef = db.collection('mcpOAuthRefreshTokens').doc(hashToken(refreshToken));
      if (grant === 'authorization_code') {
        const code = single(body.code);
        const redirect = single(body.redirect_uri);
        const verifier = single(body.code_verifier);
        if (!/^[A-Za-z0-9_-]{43}$/.test(code) ||
            !client.redirect_uris.includes(redirect) ||
            !validVerifier(verifier)) throw E('invalid_grant');
        const ref = db.collection('mcpOAuthCodes').doc(hashToken(code));
        authorization = await db.runTransaction(async tx => {
          const snap = await tx.get(ref);
          const record = snap.exists ? snap.data() : null;
          if (!record || record.clientId !== clientId || record.redirect !== redirect ||
              record.expiresAtMs <= clock() ||
              record.challenge !== pkceChallenge(verifier) ||
              (body.resource && normalizeResource(body.resource) !== record.resource)) throw E('invalid_grant');
          const issued = {
            userId: record.userId, clientId, resource: record.resource, scopes: record.scopes,
            expiresAtMs: clock() + REFRESH_TTL_MS,
          };
          tx.delete(ref);
          tx.create(refreshRef, issued);
          return issued;
        });
      } else {
        const oldToken = single(body.refresh_token);
        if (!/^[A-Za-z0-9_-]{43}$/.test(oldToken)) throw E('invalid_grant');
        const ref = db.collection('mcpOAuthRefreshTokens').doc(hashToken(oldToken));
        authorization = await db.runTransaction(async tx => {
          const snap = await tx.get(ref);
          const record = snap.exists ? snap.data() : null;
          if (!record || record.clientId !== clientId || record.expiresAtMs <= clock() ||
              (body.resource && normalizeResource(body.resource) !== record.resource)) throw E('invalid_grant');
          tx.delete(ref);
          tx.create(refreshRef, record);
          return record;
        });
      }
      const accessToken = mintAccessToken({
        userId: authorization.userId, clientId, resource: authorization.resource,
        scopes: authorization.scopes, now: clock(),
      });
      return res.set('Cache-Control', 'no-store').json({
        access_token: accessToken, token_type: 'Bearer',
        expires_in: ACCESS_TTL_SECONDS, refresh_token: refreshToken,
        scope: authorization.scopes,
      });
    } catch (err) {
      if (err.oauthError) return error(res, err.status, err.oauthError, 'OAuth exchange rejected');
      // Never expose secrets, Firestore errors or token content to the caller.
      console.error('[mcp-oauth] exchange error', err?.name || 'Error');
      return error(res, 503, 'temporarily_unavailable', 'OAuth exchange unavailable');
    }
  });
  return router;
}
