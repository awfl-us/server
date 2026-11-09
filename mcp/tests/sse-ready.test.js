import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createSSEConnection } from '../../workflows/events/sse.js';

test('SSE only writes its ready frame when explicitly marked subscribed', () => {
  const chunks = [];
  let ended = false;
  const response = {
    write: data => { chunks.push(data); return true; },
    end: () => { ended = true; },
  };
  const sse = createSSEConnection(response, { heartbeatMs: 15000 });
  try {
    assert.deepEqual(chunks, []); // No early success before workspace validation.
    assert.equal(sse.ready(), true);
    assert.deepEqual(chunks, [': ready\n\n']);
    assert.equal(sse.sendEvent({ id: 'event-1', type: 'message', data: { hello: true } }), true);
    assert.deepEqual(chunks[1], 'id: event-1\nevent: message\ndata: {"hello":true}\n\n');
  } finally {
    sse.close();
  }
  assert.equal(ended, true);
  assert.equal(sse.ready(), false);
});

test('ready frame flushes HTTP SSE response headers without an event or heartbeat', async () => {
  let resolveReady;
  const readyToRespond = new Promise(resolve => { resolveReady = resolve; });
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    const sse = createSSEConnection(res, { heartbeatMs: 15000 });
    res.once('close', () => sse.close()); // Clear the heartbeat interval.
    resolveReady(() => sse.ready());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    const request = fetch('http://127.0.0.1:' + address.port + '/stream', {
      signal: AbortSignal.timeout(3000),
    });
    // Wait for Node's HTTP request handler, rather than assuming it executes
    // within a fixed number of milliseconds on a loaded CI runner.
    const markReady = await readyToRespond;
    assert.equal(typeof markReady, 'function');
    markReady();
    const response = await request;
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const reader = response.body.getReader();
    const { value } = await reader.read();
    assert.equal(new TextDecoder().decode(value), ': ready\n\n');
    await reader.cancel();
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
