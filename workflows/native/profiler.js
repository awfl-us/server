// Opt-in timing instrumentation for one IAM-authenticated native Jobs request.
// Only fixed operation names, timings and an execution ID are logged; never
// workflow inputs, URLs, identity headers or credentials.
import { performance } from 'node:perf_hooks';

const STORE_OPS = new Set([
  'get', 'claim', 'renew', 'prepareEffect', 'recordEffect',
  'recordEffectFailure', 'failPendingHttp', 'failPendingParallel',
  'getEffect', 'complete', 'fail',
]);

export function createNativeProfiler({ enabled = false, executionId, logger = console } = {}) {
  if (!enabled) return null;
  const started = performance.now();
  const stats = new Map();
  const measure = async (name, operation) => {
    const begin = performance.now();
    try { return await operation(); }
    finally {
      const durationMs = performance.now() - begin;
      const current = stats.get(name) || { count: 0, totalMs: 0 };
      current.count++;
      current.totalMs += durationMs;
      stats.set(name, current);
    }
  };
  const instrument = (target, kind, selected) => {
    if (!target) return target;
    return new Proxy(target, {
      get(object, name) {
        const value = Reflect.get(object, name, object);
        if (typeof value !== 'function') return value;
        const call = value.bind(object);
        if (!selected(name)) return call;
        return (...args) => measure(`${kind}.${name}`, () => call(...args));
      },
    });
  };
  const summary = outcome => ({
    event: 'awfl_native_job_timing',
    executionId,
    outcome,
    durationMs: Math.round(performance.now() - started),
    phases: Object.fromEntries([...stats.entries()].map(([name, item]) => [name, {
      count: item.count, totalMs: Math.round(item.totalMs * 100) / 100,
    }])),
  });
  return {
    measure,
    store: target => instrument(target, 'firestore', name => STORE_OPS.has(name)),
    releases: target => instrument(target, 'gcs', name => name === 'materialize'),
    handlers: target => instrument(target, 'effect', name => typeof name === 'string' &&
      ['http.get', 'http.post', 'http.patch', 'http.delete', 'log.write'].includes(name)),
    report: outcome => logger.info(summary(outcome)),
    summary,
  };
}
