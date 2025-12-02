# Producer stop endpoint and runtime info persistence

This document describes the new POST /jobs/producer/stop endpoint and the runtime info persisted in the project consumer lock to enable targeted shutdown.

Overview
- On producer start, we acquire the project consumer lock and persist runtime metadata under consumerLock.runtime.
- POST /jobs/producer/stop inspects that runtime metadata to stop the correct instances, then force-releases the lock.

Runtime info shape (consumerLock.runtime)
- mode: 'local-docker' | 'cloud-run'
- stopRequested: boolean
- local-docker mode:
  - producer: { containerName: string, containerId: string }
  - sidecar?: { containerName: string, containerId: string | null, port: number }
- cloud-run mode:
  - jobName: string
  - location: string (region)
  - operation?: string (Run Jobs long-running op name)
  - sidecarEnabled: boolean

Start flow updates
- jobs/producer/index.js now records runtime info immediately after launching the producer (both local-docker and Cloud Run modes) via workflows/projects/lock.setConsumerRuntimeInfo().

Stop endpoint
- Route: POST /jobs/producer/stop
- Behavior:
  - local-docker: stop the producer container and its consumer sidecar container (if present) using Docker, then force-release the consumer lock.
  - cloud-run: mark runtime.stopRequested = true and force-release the consumer lock. This is a placeholder until we wire job cancellation or a consumer service signal.
  - unknown/no runtime: just force-release the lock.

Notes
- Files are kept under 275 lines; extra monitor logic lives in jobs/producer/monitor.js.
- Lock helpers added in workflows/projects/lock.js:
  - setConsumerRuntimeInfo({ userId, projectId, consumerId, runtime })
  - getConsumerLock({ userId, projectId })

Next steps (Cloud Run cancellation)
- Add a follow-up task to implement actual job cancellation or a shutdown signal to the consumer service:
  - If using Cloud Run Jobs: call projects.locations.operations.cancel on the running operation, or
  - If using a dedicated consumer service: POST an authenticated shutdown signal to the service, which should then release the lock on exit.
- Ensure idempotency and authorization on the stop path; consider scoping stop to the matching consumerId.

Local testing (Docker)
1) Start with sidecar enabled (optional):
   - export PRODUCER_SIDECAR_ENABLE=1
2) Start via local Docker:
   - POST /jobs/producer/start with { "localDocker": true }
3) Verify lock.runtime contains mode=local-docker and container names/ids.
4) POST /jobs/producer/stop
5) Confirm both producer and sidecar containers are stopped and the lock is released.
