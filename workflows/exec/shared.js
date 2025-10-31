// Shared constants and helpers for workflows exec routes
import { Timestamp } from 'firebase-admin/firestore';

export const COLLECTIONS = {
  links: 'workflowExecLinks',
  regs: 'workflowExecsBySession',
  statuses: 'workflowExecStatus',
  locksConvoSession: 'locks.Convo.Session',
};

// Normalize timestamp-like values to seconds
export const toSeconds = (v) => {
  if (v == null) return 0;
  if (v instanceof Timestamp) return v.seconds;
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Ensure workflow name matches execution naming used by /workflows/execute
// Appends WORKFLOW_ENV if set and not already present at the end of the name
export function withEnvSuffix(name) {
  const n = String(name || '').trim();
  const suffix = process.env.WORKFLOW_ENV || '';
  if (!suffix) return n;
  return n.endsWith(suffix) ? n : `${n}${suffix}`;
}
