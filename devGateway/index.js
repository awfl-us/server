import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { CoreV1Api } from '@kubernetes/client-node';
import { clientAuth } from '../workflows/userAuth.js';
import { getConsumerLock } from '../workflows/projects/lock.js';
import { getKubeConfig } from '../jobs/producer/gke.js';
import { forwardPodHttp } from './upstream.js';
import { resolveLiveWorkspace, readyJobPod, verifyWorkflowIdentity, validWorkspaceId, validPort } from './resolve.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const makeToken = () => randomBytes(32).toString('hex');
const googleOidc = new OAuth2Client();
const PREVIEW_LIFETIME = 15 * 60 * 1000;
const TICKET_LIFETIME = 60 * 1000;

function originFromConfig(mode) {
  // The jobs service is IAM-protected for OIDC Workflow calls; the public API
  // hosts browser previews. They share one forwarding implementation.
  const fallback = mode === 'preview' ? (process.env.API_ORIGIN || 'https://api.awfl.us') :
    (process.env.WORKFLOWS_BASE_URL || 'https://jobs.awfl.us');
  const url = new URL(process.env.AWFL_DEV_GATEWAY_ORIGIN || fallback);
  if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password) {
    throw new Error('Invalid jobs origin for dev gateway');
  }
  return url.origin;
}

let projectNumberCache = '';
async function allowedWorkflowEmails() {
  const explicit = (process.env.AWFL_DEV_WORKFLOW_SERVICE_ACCOUNTS || '').split(',')
    .map(v => v.trim().toLowerCase()).filter(Boolean);
  if (explicit.length) return explicit;
  if (!projectNumberCache) {
    const response = await fetch('http://metadata.google.internal/computeMetadata/v1/project/numeric-project-id', {
      headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error('Unable to resolve project number');
    projectNumberCache = (await response.text()).trim();
    if (!/^\d{8,20}$/.test(projectNumberCache)) throw new Error('Invalid project number');
  }
  return [`${projectNumberCache}-compute@developer.gserviceaccount.com`];
}

function parsePreviewCookie(header, workspaceId) {
  const key = `__Secure-awfl-dev-${workspaceId}=`;
  for (const segment of String(header || '').split(';')) {
    const pair = segment.trim();
    if (pair.startsWith(key) && /^[a-f0-9]{64}$/.test(pair.slice(key.length))) return pair.slice(key.length);
  }
  return null;
}

function invalidSession(res) {
  return res.status(401).set('Cache-Control','no-store').json({error:'Preview authorization required'});
}

export function createDevGateway({ db, isOwner, mode = 'workflow', getLock = getConsumerLock,
  kubernetes = getKubeConfig, verifyGoogleToken = async (token, audience) =>
    (await googleOidc.verifyIdToken({ idToken: token, audience })).getPayload(),
  getAllowedWorkflowEmails = allowedWorkflowEmails, httpForward = forwardPodHttp } = {}) {
  if (!db || typeof isOwner !== 'function') throw new Error('Gateway needs database and owner authorization');
  if (mode !== 'workflow' && mode !== 'preview') throw new Error('Invalid gateway mode');
  const proxyRouter = express.Router();
  const accessRouter = express.Router();
  const baseOrigin = originFromConfig(mode);

  async function live(id) {
    const snap = await db.collection('mcpWorkspaces').doc(id).get();
    if (!snap.exists) throw new Error('Workspace unavailable');
    const workspace = snap.data();
    if (!await isOwner(workspace.userId)) throw new Error('Workspace unavailable');
    const { lock } = await getLock({ userId:workspace.userId, projectId:workspace.projectId });
    const consumer = resolveLiveWorkspace(workspace, lock);
    return { workspace, consumer };
  }

  accessRouter.use((_req,res,next) => mode === 'preview' ? next() : res.status(404).end());
  accessRouter.post('/sessions', clientAuth, async (req,res) => {
    try {
      const id = req.body?.workspace_id;
      const port = req.body?.port;
      if (!validWorkspaceId(id) || !validPort(port)) return res.status(400).json({error:'Invalid workspace or port'});
      const { workspace, consumer } = await live(id);
      if (req.userId !== workspace.userId) return res.status(404).json({error:'Workspace unavailable'});
      const ticket = makeToken();
      const now = Date.now();
      await db.collection('devGatewayTickets').doc(sha256(ticket)).set({
        userId:req.userId, workspaceId:id, projectId:workspace.projectId,
        port:Number(port), consumerId:consumer.consumerId, generation:consumer.generation,
        expiresAt:now+TICKET_LIFETIME, expires_at:new Date(now+TICKET_LIFETIME) });
      res.set('Cache-Control','no-store').json({
        launch_url:`${baseOrigin}/dev-access/redeem/${ticket}`,
        expires_at:now+TICKET_LIFETIME });
    } catch (error) {
      console.warn('[dev-gateway] preview creation failed',error?.message || 'unknown');
      res.status(503).json({error:'Preview unavailable'});
    }
  });

  accessRouter.get('/redeem/:ticket', async (req,res) => {
    const ticket = req.params.ticket;
    if (!/^[a-f0-9]{64}$/.test(ticket)) return res.status(404).end();
    try {
      const ref = db.collection('devGatewayTickets').doc(sha256(ticket));
      const record = await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists || snap.data().expiresAt <= Date.now()) return null;
        tx.delete(ref); // One-time redemption even under concurrent requests.
        return snap.data();
      });
      if (!record) return res.status(410).set('Cache-Control','no-store').send('Preview link expired');
      const { workspace, consumer } = await live(record.workspaceId);
      if (workspace.userId !== record.userId || workspace.projectId !== record.projectId ||
          consumer.consumerId !== record.consumerId || consumer.generation !== record.generation) {
        return res.status(410).send('Workspace restarted');
      }
      const token = makeToken();
      const now = Date.now();
      await db.collection('devGatewaySessions').doc(sha256(token)).set({
        ...record, expiresAt:now+PREVIEW_LIFETIME, expires_at:new Date(now+PREVIEW_LIFETIME) });
      res.set('Cache-Control','no-store');
      res.set('Referrer-Policy','no-referrer');
      res.cookie(`__Secure-awfl-dev-${record.workspaceId}`,token,{
        secure:true,httpOnly:true,sameSite:'lax',path:'/dev',maxAge:PREVIEW_LIFETIME });
      return res.redirect(303,`${baseOrigin}/dev/${record.workspaceId}/${record.port}/`);
    } catch (error) {
      console.warn('[dev-gateway] preview redemption unavailable',error?.message || 'unknown');
      return res.status(503).send('Preview unavailable');
    }
  });

  // This handler is mounted before express.json() to preserve raw request
  // bodies, HTML streams and static files in the dev server.
  proxyRouter.use(async (req,res) => {
    const delimiter = req.url.indexOf('?');
    const pathname = delimiter < 0 ? req.url : req.url.slice(0,delimiter);
    const search = delimiter < 0 ? '' : req.url.slice(delimiter);
    const m = /^\/([a-f0-9]{32})\/(\d{1,5})(\/.*)?$/.exec(pathname);
    if (!m || !validWorkspaceId(m[1]) || !validPort(m[2]) || req.url.length > 8192) return res.status(404).end();
    const id=m[1], port=Number(m[2]), path=m[3] || '/';
    try {
      const { workspace, consumer } = await live(id);
      const authorization = req.get('authorization') || '';
      let workflowHeaders = {};
      if (mode === 'workflow') {
        const bearer = /^Bearer (\S+)$/.exec(authorization);
        if (!bearer) return invalidSession(res);
        // Cloud Run validates against the service origin before this handler
        // sees the request. A dynamic /dev/<workspace>/<port> audience would
        // be rejected there. Dev workflows use an optional OIDC_AUDIENCE
        // override while keeping BASE_URL workspace-specific for routing.
        const audience = baseOrigin;
        const claims = await verifyGoogleToken(bearer[1],audience);
        verifyWorkflowIdentity(claims, {audience,allowedEmails:await getAllowedWorkflowEmails()});
        // Workflows already supply these identity headers. Never trust their
        // values: only forward the owner and project resolved from Firestore.
        if ((req.get('x-user-id') && req.get('x-user-id') !== workspace.userId) ||
            (req.get('x-project-id') && req.get('x-project-id') !== workspace.projectId)) return invalidSession(res);
        workflowHeaders = {'x-user-id':workspace.userId,'x-project-id':workspace.projectId};
      } else {
        if (authorization) return invalidSession(res);
        const token = parsePreviewCookie(req.get('cookie'),id);
        if (!token) return invalidSession(res);
        const session = await db.collection('devGatewaySessions').doc(sha256(token)).get();
        const value = session.data();
        if (!session.exists || value.expiresAt <= Date.now() || value.workspaceId !== id ||
            value.port !== port || value.userId !== workspace.userId ||
            value.projectId !== workspace.projectId ||
            value.consumerId !== consumer.consumerId || value.generation !== consumer.generation) return invalidSession(res);
        const requestOrigin = req.get('origin');
        if (requestOrigin && requestOrigin !== baseOrigin) return invalidSession(res);
      }
      const kc = await kubernetes();
      const pods = (await kc.makeApiClient(CoreV1Api).listNamespacedPod(consumer.namespace)).body.items;
      const podName = readyJobPod(pods,consumer.jobName);
      await httpForward({req,res,kc,namespace:consumer.namespace,podName,port,
        workspaceId:id,path,search,workflowHeaders});
    } catch (error) {
      console.warn('[dev-gateway] forwarding failed',error?.message || 'unknown');
      if (!res.headersSent) res.status(502).set('Cache-Control','no-store').json({error:'Development server unreachable'});
    }
  });

  return {proxyRouter,accessRouter};
}
