/**
 * Kubernetes Job status counters are cumulative. An evicted pod increments
 * status.failed even while the Job has a healthy replacement (status.active).
 * Only terminal Job conditions or exhausted retries make the Job failed.
 *
 * Do not relax the capability, project grant, or live-lock checks when a
 * replacement pod asks for a fresh Firebase token.
 */
export function classifyK8sJob(job) {
  if (job?.metadata?.deletionTimestamp) return 'terminating';
  const status = job?.status || {};
  const conditions = Array.isArray(status.conditions) ? status.conditions : [];
  const hasCondition = type => conditions.some(
    condition => condition?.type === type && (condition.status === 'True' || condition.status === true)
  );

  if (hasCondition('Failed') || hasCondition('FailureTarget')) return 'failed';
  if (hasCondition('Complete') || hasCondition('SuccessCriteriaMet')) return 'completed';
  // A previous pod failure is NOT a failure of the active replacement.
  if (Number(status.active || 0) > 0) return 'active';

  // No active pod can be normal while Kubernetes is applying job backoff.
  // A Job is terminal once its failure budget is exhausted, even if the
  // controller has not yet populated the Failed condition.
  const failures = Number(status.failed || 0);
  const maxFailures = Number(job?.spec?.backoffLimit);
  if (Number.isFinite(maxFailures) && job?.spec?.backoffLimit != null &&
      failures > maxFailures) return 'failed';

  const completions = Number(job?.spec?.completions ?? 1);
  if (Number(status.succeeded || 0) >= completions) return 'completed';
  return 'pending';
}
