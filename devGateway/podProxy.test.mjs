import test from 'node:test';
import assert from 'node:assert/strict';
import { podProxyUrl, forwardedDevHeaders } from './podProxy.js';

const base = { apiServer: 'https://gke.example.test', namespace: 'awfl', podName: 'consumer-abc-xyz', port: 5050 };

test('routes both Workflows APIs and UI assets through the same pod target', () => {
  assert.equal(podProxyUrl({ ...base, path: '/agents/session/123', search: '?full=1' }).href,
    'https://gke.example.test/api/v1/namespaces/awfl/pods/consumer-abc-xyz:5050/proxy/agents/session/123?full=1');
  assert.equal(podProxyUrl({ ...base, path: '/assets/app.js' }).pathname,
    '/api/v1/namespaces/awfl/pods/consumer-abc-xyz:5050/proxy/assets/app.js');
});

test('rejects arbitrary URLs, traversal, invalid ports, and spoofed pods', () => {
  for (const path of ['//evil.test', '/../secrets', '/%2e%2e/secrets', '/%2Fapi', '/hello?bad=1', '/hello#bad']) {
    assert.throws(() => podProxyUrl({ ...base, path }));
  }
  assert.throws(() => podProxyUrl({ ...base, apiServer: 'http://example.test' }));
  assert.throws(() => podProxyUrl({ ...base, port: 70000 }));
  assert.throws(() => podProxyUrl({ ...base, podName: '../someone-elses-pod' }));
});

test('does not forward gateway credentials or caller-controlled routing headers', () => {
  assert.deepEqual(forwardedDevHeaders({ Accept: 'text/html', 'content-type': 'application/json',
    authorization: 'Bearer secret', cookie: 'preview-secret=anything', host: 'evil.test',
    'x-forwarded-host': 'evil.test', 'x-user-id': 'spoofed' }),
    { Accept: 'text/html', 'content-type': 'application/json' });
});
