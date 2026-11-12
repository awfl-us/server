// Called as a SEPARATE Node process by the real Firestore emulator suite.
// Never accepts a production project ID and never dispatches native effects.
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { NativeExecutionStore } from './executionStore.js';

if (!process.env.FIRESTORE_EMULATOR_HOST || process.argv.length !== 4) {
  throw new Error('parallel lease contender requires emulator and collection/execution ID');
}
const [collection, executionId] = process.argv.slice(2);
if (!/^nativeParallelEmulator_[a-f0-9]{32}$/.test(collection) ||
    !/^native_[a-f0-9]{32}$/.test(executionId)) {
  throw new Error('invalid demo execution identity');
}
const app = initializeApp({ projectId: 'demo-awfl-native' });
const db = getFirestore(app);
try {
  const store = new NativeExecutionStore({ db, collection });
  try {
    const result = await store.claim({
      executionId, workerId: 'independent_process_contender', leaseMs: 60000,
    });
    if (result.completed) {
      console.log('ALREADY_COMPLETED');
    } else if (result.cancelled) {
      console.log('ALREADY_CANCELLED');
    } else {
      console.error('UNEXPECTED_PARENT_LEASE_ACQUIRED');
      process.exitCode = 2;
    }
  } catch (error) {
    if (error.code !== 'CONFLICT' || !/lease held/.test(error.message)) throw error;
    console.log('ACTIVE_PARENT_LEASE_HELD');
  }
} finally {
  await db.terminate();
  await deleteApp(app);
}
