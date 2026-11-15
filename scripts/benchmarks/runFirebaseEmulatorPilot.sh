#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
# Run only against the Firebase *demo* project. These intentionally open rules
# are for the local emulator only; never deploy them to a real database.
export STORAGE_PILOT_EMULATORS=1
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8089
export RTDB_EMULATOR_HOST=127.0.0.1:9009
export RTDB_EMULATOR_NAMESPACE=demo-awfl-default-rtdb
export GCP_PROJECT_ID=demo-awfl
export GOOGLE_CLOUD_PROJECT=demo-awfl
node --test test/storage/firebaseEmulators.test.mjs
if [[ "${BENCHMARK:-0}" == "1" ]]; then
  n="${BENCHMARK_RUNS:-200}"
  c="${BENCHMARK_CONCURRENCY:-1}"
  node scripts/benchmarks/storagePilot.mjs --backend=firestore --runs="$n" --concurrency="$c" --warmup=15
  node scripts/benchmarks/storagePilot.mjs --backend=rtdb --runs="$n" --concurrency="$c" --warmup=15
fi
