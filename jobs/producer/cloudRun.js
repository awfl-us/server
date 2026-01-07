import { getAccessToken } from './utils.js';

export async function runCloudRunJob({ gcpProject, location, jobName, containerOverrides }) {
  const url = `https://run.googleapis.com/v2/projects/${encodeURIComponent(gcpProject)}/locations/${encodeURIComponent(location)}/jobs/${encodeURIComponent(jobName)}:run`;
  const token = await getAccessToken();
  const payload = containerOverrides && Array.isArray(containerOverrides)
    ? { overrides: { containerOverrides } }
    : {};
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

export async function cancelOperation({ name }) {
  if (!name) return { ok: false, status: 400, data: { error: 'missing operation name' } };
  const token = await getAccessToken();
  const url = `https://run.googleapis.com/v2/${name}:cancel`;
  const resp = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  let data = {};
  try { data = await resp.json(); } catch {}
  return { ok: resp.ok, status: resp.status, data };
}

export async function listExecutions({ gcpProject, location, jobName }) {
  const token = await getAccessToken();
  const url = `https://run.googleapis.com/v2/projects/${encodeURIComponent(gcpProject)}/locations/${encodeURIComponent(location)}/jobs/${encodeURIComponent(jobName)}/executions`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  let data = {};
  try { data = await resp.json(); } catch {}
  return { ok: resp.ok, status: resp.status, data };
}

export async function deleteExecution({ name }) {
  if (!name) return { ok: false, status: 400 };
  const token = await getAccessToken();
  const url = `https://run.googleapis.com/v2/${name}`;
  const resp = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  let data = {};
  try { data = await resp.json(); } catch {}
  return { ok: resp.ok, status: resp.status, data };
}

export async function cancelJobExecutions({ gcpProject, location, jobName }) {
  try {
    const listed = await listExecutions({ gcpProject, location, jobName });
    if (!listed.ok) return { ok: false, status: listed.status, data: listed.data };
    const items = Array.isArray(listed.data?.executions) ? listed.data.executions : [];
    const running = items.filter((e) => !e?.done && !/SUCCEEDED|FAILED|CANCELLED/i.test(String(e?.conditions?.find?.(c => c?.type === 'Completed')?.state || '')));
    const deletions = await Promise.allSettled(running.map((e) => deleteExecution({ name: e.name })));
    const ok = deletions.some((r) => r.status === 'fulfilled' && r.value?.ok);
    return { ok, status: ok ? 200 : 500, data: { count: running.length } };
  } catch (e) {
    return { ok: false, status: 500, data: { error: String(e?.message || e) } };
  }
}

// Lightweight helpers for readiness/monitoring
export async function getOperation({ name }) {
  if (!name) return { ok: false, status: 400, data: { error: 'missing operation name' } };
  const token = await getAccessToken();
  const url = `https://run.googleapis.com/v2/${name}`; // name: projects/.../locations/.../operations/...
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  let data = {};
  try { data = await resp.json(); } catch {}
  return { ok: resp.ok, status: resp.status, data };
}

export async function getExecutionByName({ name }) {
  if (!name) return { ok: false, status: 400, data: { error: 'missing execution name' } };
  const token = await getAccessToken();
  const url = `https://run.googleapis.com/v2/${name}`; // name: projects/.../locations/.../jobs/.../executions/...
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  let data = {};
  try { data = await resp.json(); } catch {}
  return { ok: resp.ok, status: resp.status, data };
}
