import { performance } from 'node:perf_hooks';
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
export class PilotLatency {
  constructor() { this.samples = new Map(); this.errors = new Map(); }
  async measure(name, call) {
    const start = performance.now();
    try { return await call(); }
    catch (error) { this.errors.set(name, (this.errors.get(name) || 0) + 1); throw error; }
    finally {
      const samples = this.samples.get(name) || [];
      samples.push(performance.now() - start);
      this.samples.set(name, samples);
    }
  }
  report() {
    return Object.fromEntries([...this.samples.entries()].map(([name, samples]) => {
      const sorted = [...samples].sort((a,b) => a-b);
      return [name, { n: samples.length, errors: this.errors.get(name) || 0,
        p50: quantile(sorted, .5), p90: quantile(sorted, .9),
        p95: quantile(sorted, .95), p99: quantile(sorted, .99),
        min: sorted[0], max: sorted.at(-1) }];
    }));
  }
}
