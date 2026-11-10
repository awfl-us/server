// GKE Autopilot requires ephemeral-storage requests and limits to match.
// Otherwise admission may rewrite the limit down to the request, leaving
// development tooling (sbt, npm and browser caches) vulnerable to eviction.
// Keep CPU/memory allocations unchanged. An explicit custom image gets the
// general-purpose allocation rather than silently inheriting Scala's cost.
export function consumerResourcesForProfile(imageProfile) {
  const storage = imageProfile === 'scala' ? '4Gi'
    : imageProfile === 'lightweight' ? '1Gi' : '2Gi';
  const cpu = imageProfile === 'scala' ? '1'
    : imageProfile === 'lightweight' ? '250m' : '500m';
  const memory = imageProfile === 'scala' ? '2Gi'
    : imageProfile === 'lightweight' ? '1Gi' : '1536Mi';

  return {
    requests: { cpu, memory, 'ephemeral-storage': storage },
    limits: { cpu: '2', memory: '4Gi', 'ephemeral-storage': storage },
  };
}
