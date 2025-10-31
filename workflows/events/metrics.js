// Minimal in-memory Prometheus-style metrics for relay
const counters = new Map();

export function incCounter(name, inc = 1) {
  const key = String(name);
  const cur = counters.get(key) || 0;
  counters.set(key, cur + Number(inc || 0));
}

export const metrics = {
  contentType: 'text/plain; version=0.0.4; charset=utf-8',
  async metrics() {
    const lines = [];
    // Declare known counters with TYPE headers for readability
    const known = [
      'relay_events_ingested_total',
      'relay_events_streamed_total',
      'relay_events_replayed_total',
      'relay_events_dropped_total',
    ];
    for (const name of known) {
      lines.push(`# TYPE ${name} counter`);
      const val = counters.get(name) || 0;
      lines.push(`${name} ${val}`);
    }
    // Emit any additional dynamic counters not in known list
    for (const [name, val] of counters.entries()) {
      if (known.includes(name)) continue;
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name} ${val}`);
    }
    lines.push('');
    return lines.join('\n');
  },
};
