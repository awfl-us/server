// GKE Autopilot requires ephemeral-storage requests and limits to match.
// Otherwise admission may rewrite the limit down to the request, leaving
// development tooling (sbt, npm and browser caches) vulnerable to eviction.
// Keep CPU/memory allocations unchanged. An explicit custom image gets the
// general-purpose allocation rather than silently inheriting Scala's cost.
export function consumerResourcesForProfile(imageProfile) {
  // npm/pip caches and browser downloads can exceed 1Gi during MCP work.
  // Keep requests and limits equal for GKE Autopilot; the namespace quota
  // does not protect a pod from its own ephemeral-storage limit.
  const storage = '4Gi';
  const cpu = imageProfile === 'scala' ? '1'
    : imageProfile === 'lightweight' ? '250m' : '500m';
  const memory = imageProfile === 'scala' ? '2Gi'
    : imageProfile === 'lightweight' ? '1Gi' : '1536Mi';

  return {
    requests: { cpu, memory, 'ephemeral-storage': storage },
    limits: { cpu: '2', memory: '4Gi', 'ephemeral-storage': storage },
  };
}
