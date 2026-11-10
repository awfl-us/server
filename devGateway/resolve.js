// Resolve a dev workspace to only its existing live, owned, project-scoped
// GKE consumer. The requested HTTP port is NOT a Kubernetes resource name.
export function resolveLiveWorkspace(workspace, lock, now = Date.now()) {
  if (!workspace || workspace.stopped || workspace.expiresAt <= now ||
      !workspace.userId || !workspace.projectId) throw new Error('Workspace unavailable');
  const runtime = lock?.runtime;
  const hb = lock?.heartbeat;
  if (!lock || lock.expiresAt <= now || runtime?.mode !== 'gke' ||
      !runtime.consumerJobName || !/^[-a-z0-9]+$/.test(runtime.consumerJobName) ||
      !hb || hb.consumerId !== lock.consumerId || hb.generation !== lock.acquiredAt ||
      hb.connected !== true || !Number.isFinite(hb.at) || now - hb.at > 30000) {
    throw new Error('Consumer unavailable');
  }
  return { consumerId: lock.consumerId, generation: lock.acquiredAt,
    jobName: runtime.consumerJobName, namespace: runtime.namespace || 'awfl' };
}

export function readyJobPod(items, jobName) {
  const matches = (items || []).filter(p =>
    p?.metadata?.name && !p.metadata.deletionTimestamp &&
    p.status?.phase === 'Running' &&
    p.metadata.ownerReferences?.some(ref => ref.kind === 'Job' && ref.name === jobName && ref.controller === true) &&
    p.status.conditions?.some(c => c.type === 'Ready' && c.status === 'True'));
  if (matches.length !== 1) throw new Error('Expected exactly one ready consumer pod');
  return matches[0].metadata.name;
}

export function verifyWorkflowIdentity(claims, { audience, allowedEmails }) {
  if (!claims || claims.aud !== audience || !claims.email_verified ||
      !allowedEmails.includes(String(claims.email || '').toLowerCase())) {
    throw new Error('Workflow identity denied');
  }
  return claims.email;
}

export const validWorkspaceId = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
export const validPort = port => Number.isInteger(Number(port)) && Number(port) > 0 && Number(port) <= 65535 && /^\d{1,5}$/.test(String(port));
