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

  return { sendEvent, close };
}
