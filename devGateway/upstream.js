import https from 'node:https';
import fs from 'node:fs';
import { podProxyUrl, forwardedDevHeaders } from './podProxy.js';

const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'set-cookie', 'www-authenticate',
  'access-control-allow-origin', 'access-control-allow-credentials', 'content-security-policy-report-only']);

export function responseHeaders(headers) {
  return Object.fromEntries(Object.entries(headers || {}).filter(([name, value]) =>
    !hopHeaders.has(name.toLowerCase()) && value != null && !/^x-kubernetes-/.test(name.toLowerCase()) &&
    !/^x-goog-/.test(name.toLowerCase())));
}

// Proxy only to a server-selected Kubernetes Pod; callers cannot provide URL,
// namespace, pod name, or bearer credentials. The API server removes the K8s
// Authorization header when forwarding a request to the pod.
export async function forwardPodHttp({ req, res, kc, namespace, podName, port, workspaceId, path, search,
  workflowHeaders = {} }) {
  const cluster = kc.getCurrentCluster();
  const user = kc.getCurrentUser();
  if (!cluster?.server || !user?.token || cluster.skipTLSVerify) throw new Error('Kubernetes TLS/auth unavailable');
  const target = podProxyUrl({ apiServer: cluster.server, namespace, podName, port, path, search });
  const allowed = new Set(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']);
  if (!allowed.has(req.method)) throw new Error('Unsupported HTTP method');
  const maxBody = 5 * 1024 * 1024;
  const claimedSize = Number(req.headers['content-length'] || 0);
  if (!Number.isSafeInteger(claimedSize) || claimedSize < 0 || claimedSize > maxBody) throw new Error('Request body too large');
  const headers = { ...forwardedDevHeaders(req.headers), ...workflowHeaders,
    'x-forwarded-prefix': `/dev/${workspaceId}/${port}`,
    'x-forwarded-proto': 'https',
    authorization: `Bearer ${user.token}` };
  if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];
  const opts = { protocol:'https:', hostname:target.hostname, port:target.port || 443,
    path:target.pathname + target.search, method:req.method, headers, timeout:120000,
    rejectUnauthorized:true };
  if (cluster.caData) opts.ca = Buffer.from(cluster.caData, 'base64');
  else if (cluster.caFile) opts.ca = fs.readFileSync(cluster.caFile);
  return await new Promise((resolve, reject) => {
    let sent = false;
    const upstream = https.request(opts, response => {
      sent = true;
      res.status(response.statusCode || 502);
      for (const [name,value] of Object.entries(responseHeaders(response.headers))) {
        if (name.toLowerCase() === 'location') {
          // No untrusted off-domain redirects from an ephemeral dev process.
          if (typeof value === 'string' && (value.startsWith('/') && !value.startsWith('//'))) {
            res.setHeader(name, `/dev/${workspaceId}/${port}${value}`);
          }
        } else res.setHeader(name, value);
      }
      response.on('error', error => { res.destroy(error); reject(error); });
      response.on('end', resolve);
      response.pipe(res);
    });
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBody) upstream.destroy(new Error('Request body too large'));
    });
    upstream.on('timeout', () => upstream.destroy(new Error('Pod proxy timed out')));
    upstream.on('error', error => {
      if (!sent) reject(error);
      else { res.destroy(error); reject(error); }
    });
    req.on('aborted', () => upstream.destroy(new Error('Client disconnected')));
    req.pipe(upstream);
  });
}
