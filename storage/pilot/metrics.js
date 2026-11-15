import { performance } from 'node:perf_hooks';
const quantile = (sorted, q) => sorted.length
  ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] : null;

// Strictly separate successful operation timings from failed requests. A
// PERMISSION_DENIED response is not a database-write latency measurement.
export class PilotLatency {
  constructor() { this.samples = new Map(); this.errors = new Map(); }
  async measure(name, call) {
    const start = performance.now();
    try {
      const result = await call();
      const samples = this.samples.get(name) || [];
      samples.push(performance.now() - start);
      this.samples.set(name, samples);
      return result;
    } catch (error) {
      this.errors.set(name, (this.errors.get(name) || 0) + 1);
      throw error;
    }
  }
  report() {
    return Object.fromEntries([...new Set([...this.samples.keys(), ...this.errors.keys()])].map(name => {
      const sorted = [...(this.samples.get(name) || [])].sort((a, b) => a - b);
      return [name, {
        n: sorted.length, errors: this.errors.get(name) || 0,
        p50: quantile(sorted, .5), p90: quantile(sorted, .9),
        p95: quantile(sorted, .95), p99: quantile(sorted, .99),
        min: sorted[0] ?? null, max: sorted.at(-1) ?? null,
      }];
    }));
  }
}
