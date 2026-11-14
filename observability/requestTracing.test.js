import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider, SimpleSpanProcessor, InMemorySpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { tracedRequest } from './requestTracing.js';

test('tracing is opt-in and excludes sensitive request paths and fields', () => {
  const original = process.env.AWFL_FIRESTORE_TRACE_ENABLED;
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const registered = trace.setGlobalTracerProvider(provider);
  assert.equal(registered, true);
  try {
    const req = {
      method: 'POST',
      path: '/native/private-id?token=never-export',
      url: '/native/private-id?token=never-export',
      headers: { authorization: 'Bearer secret', 'x-user-id': 'secret-user' },
      body: { secret: 'never-export' },
    };
    const res = new EventEmitter();
    res.statusCode = 200;
    let nextCount = 0;
    process.env.AWFL_FIRESTORE_TRACE_ENABLED = '0';
    tracedRequest(req, res, () => { nextCount++; });
    assert.equal(nextCount, 1);
    assert.equal(exporter.getFinishedSpans().length, 0);
    process.env.AWFL_FIRESTORE_TRACE_ENABLED = '1';
    tracedRequest(req, res, () => { nextCount++; });
    assert.equal(nextCount, 2);
    res.emit('finish');
    res.emit('close');
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].name, 'awfl.http');
    assert.equal(spans[0].attributes['awfl.request.family'], 'native');
    assert.equal(spans[0].attributes['http.response.status_code'], 200);
    const serialized = JSON.stringify({
      name: spans[0].name, attributes: spans[0].attributes,
    });
    for (const sensitive of ['private-id', 'never-export', 'secret-user', 'Bearer']) {
      assert.ok(!serialized.includes(sensitive), sensitive + ' was recorded');
    }
  } finally {
    if (original === undefined) delete process.env.AWFL_FIRESTORE_TRACE_ENABLED;
    else process.env.AWFL_FIRESTORE_TRACE_ENABLED = original;
    trace.disable();
    void provider.shutdown();
  }
});

test('health checks are excluded from tracing', () => {
  process.env.AWFL_FIRESTORE_TRACE_ENABLED = '1';
  const req = { method: 'GET', path: '/health', headers: {} };
  const res = new EventEmitter();
  res.statusCode = 200;
  let called = 0;
  tracedRequest(req, res, () => { called++; });
  assert.equal(called, 1);
  delete process.env.AWFL_FIRESTORE_TRACE_ENABLED;
});
