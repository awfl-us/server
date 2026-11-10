import test from 'node:test';
import assert from 'node:assert/strict';
import { responseHeaders } from './upstream.js';

test('never relays upstream cookies or credential challenges to the browser', () => {
  assert.deepEqual(responseHeaders({ 'content-type':'text/html', 'content-length':'20',
    'set-cookie':'secret=1', connection:'close', 'www-authenticate':'Bearer token',
    'x-kubernetes-pf':'bad', 'x-goog-secret':'bad' }),
    {'content-type':'text/html','content-length':'20'});
});
