import { context, propagation, trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';

// Low-cardinality route families only. Don't export raw URL, query, headers,
// bodies, user IDs, document paths, bearer tokens or workflow arguments.
const families = new Set([
  'workflows', 'jobs', 'native', 'firebase', 'llm', 'events', 'mcp',
  'agents', 'projects', 'callbacks', 'context', 'tasks', 'oauth', 'tools',
  'health', 'readyz',
]);

export function tracedRequest(req, res, next) {
  if (process.env.AWFL_FIRESTORE_TRACE_ENABLED !== '1') return next();

  const first = String(req.path || req.url || '/').split('?')[0].split('/')[1] || '';
  if (first === 'health' || first === 'readyz' || first === 'metrics') return next();
  const family = families.has(first) ? first : 'other';
  const tracer = trace.getTracer('awfl.http', '1.0.0');
  const parent = propagation.extract(context.active(), req.headers);
  const span = tracer.startSpan('awfl.http', {
    kind: SpanKind.SERVER,
    attributes: {
      'awfl.request.family': family,
      'http.request.method': String(req.method || 'GET'),
    },
  }, parent);
  const current = trace.setSpan(parent, span);
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    span.setAttribute('http.response.status_code', res.statusCode);
    if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
  };
  res.once('finish', end);
  res.once('close', end);
  context.with(current, next);
}
