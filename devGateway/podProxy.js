// Builds a Kubernetes API-server proxy target for an already-authorized
// workspace pod. This module does not make arbitrary Kubernetes requests or
// grant access to pods; the caller must authenticate and resolve the current
// project consumer before using it.

const dnsLabel = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const podNamePattern = /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/;

export function podProxyUrl({ apiServer, namespace, podName, port, path = '/', search = '' }) {
  if (!dnsLabel.test(namespace || '') || namespace.length > 63) throw new Error('Invalid namespace');
  if (!podNamePattern.test(podName || '') || podName.length > 253) throw new Error('Invalid pod name');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const root = new URL(apiServer);
  if (root.protocol !== 'https:' || root.username || root.password || root.pathname !== '/' || root.search || root.hash) {
    throw new Error('Invalid Kubernetes API server');
  }
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\r\n\0?#]/.test(path)) {
    throw new Error('Invalid proxy path');
  }
  for (const part of path.split('/')) {
    let decoded;
    try { decoded = decodeURIComponent(part); } catch { throw new Error('Invalid path encoding'); }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
      throw new Error('Invalid proxy path segment');
    }
  }
  if (typeof search !== 'string' || (search && !search.startsWith('?')) || /[\r\n\0#]/.test(search)) {
    throw new Error('Invalid proxy query');
  }
  const target = new URL(`/api/v1/namespaces/${namespace}/pods/${podName}:${port}/proxy${path}${search}`, root);
  const requiredPrefix = `/api/v1/namespaces/${namespace}/pods/${podName}:${port}/proxy/`;
  if (!target.pathname.startsWith(requiredPrefix)) throw new Error('Proxy path escaped pod route');
  return target;
}

// Never pass a caller's OIDC credential or gateway session into a previewed
// server. The gateway authorizes those credentials before forwarding.
export function forwardedDevHeaders(headers) {
  const allowed = new Set(['accept', 'accept-language', 'content-type', 'cache-control', 'if-none-match', 'if-modified-since', 'range']);
  return Object.fromEntries(Object.entries(headers || {}).filter(([name, value]) =>
    allowed.has(name.toLowerCase()) && typeof value === 'string' && !/[\r\n]/.test(value)));
}
