export function createSSEConnection(res, options = {}) {
  const heartbeatMs = Math.max(Number(options.heartbeatMs || 15000), 1000);
  let closed = false;

  const timer = setInterval(() => {
    if (closed) return;
    try {
      // SSE heartbeat as a comment line
      res.write(`: keep-alive\n\n`);
    } catch (err) {
      // Ignore heartbeat write errors; caller will close on next failure
    }
  }, heartbeatMs);

  // Write a comment only after the caller has authenticated, validated the
  // workspace, and installed its event subscription. Unlike header-only
  // responses, actual SSE bytes reach clients without waiting 15 seconds for
  // the first idle keep-alive.
  function ready() {
    if (closed) return false;
    try { return res.write(': ready\n\n'); } catch { return false; }
  }

  function sendEvent(ev = {}) {
    if (closed) return false;
    try {
      const id = ev?.id;
      const type = ev?.type || 'message';
      const data = JSON.stringify(ev?.data ?? {});
      let frame = '';
      if (id) frame += `id: ${id}\n`;
      if (type) frame += `event: ${type}\n`;
      frame += `data: ${data}\n\n`;
      return res.write(frame);
    } catch (err) {
      return false;
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    try { clearInterval(timer); } catch {}
    try { res.end(); } catch {}
  }

  return { sendEvent, ready, close };
}
