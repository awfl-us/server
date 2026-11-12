// Kills a separate Node process after compiled Rust children have committed,
// but before their parent's fork journal. Emulator and disposable demo only.
import { appendFileSync } from 'node:fs';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { NativeExecutionStore } from './executionStore.js';
import { runNativeWorkflow } from './worker.js';

if (!process.env.FIRESTORE_EMULATOR_HOST || process.argv.length !== 6) {
  throw new Error('crash worker requires emulator, collection, execution, ELF and marker');
}
const [collection, executionId, executable, markerPath] = process.argv.slice(2);
if (!/^nativeParallelEmulator_[a-f0-9]{32}$/.test(collection) ||
    !/^native_[a-f0-9]{32}$/.test(executionId)) {
  throw new Error('invalid demo crash worker identity');
}
const app = initializeApp({ projectId: 'demo-awfl-native' });
const db = getFirestore(app);
try {
  const store = new NativeExecutionStore({ db, collection });
  const initial = await store.get(executionId);
  if (!initial || initial.workflowName !== 'NativeParallelEmulator') {
    throw new Error('missing disposable native execution');
  }
  const original = store.recordEffect.bind(store);
  store.recordEffect = async input => {
    if (input.executionId === executionId && input.effectId.startsWith('fork_')) {
      // Real process death: no finally, cleanup, or explicit exception.
      process.exit(73);
    }
    return original(input);
  };
  await runNativeWorkflow({
    store, executionId, userId: initial.userId, projectId: initial.projectId,
    releases: { materialize: async () => ({
      executable, sha256: initial.artifactSha256, cleanup: async () => {},
    }) },
    handlers: { 'http.post': async ({ args }) => {
      appendFileSync(markerPath, JSON.stringify(args) + '\n');
      return args + '-killed';
    } },
  });
  throw new Error('crash worker returned without expected process termination');
} finally {
  await db.terminate();
  await deleteApp(app);
}
