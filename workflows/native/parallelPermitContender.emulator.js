// Standalone process: all permit coordination must survive a separate Node
// runtime and Firestore client. Used only against demo-awfl-native emulator.
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { NativeExecutionStore } from './executionStore.js';

const [collection, rootExecutionId, userId, projectId, slotText, permitId, mode] =
  process.argv.slice(2);
const app = initializeApp({ projectId: 'demo-awfl-native' }, `permit-contender-${process.pid}`);
const db = getFirestore(app);
const overriddenClock = process.env.AWFL_PERMIT_TEST_CLOCK_MS;
const store = new NativeExecutionStore({ db, collection,
  ...(overriddenClock ? { clock: () => Number(overriddenClock) } : {}),
});
try {
  const permit = await store.tryAcquirePermit({
    rootExecutionId, userId, projectId, slot: Number(slotText), permitId,
    leaseMs: 120_000,
  });
  if (!permit) {
    process.stdout.write('BUSY\n');
  } else {
    process.stdout.write(`ADMITTED ${permit.epoch}\n`);
  }
  if (mode === 'crash' && permit) {
    // The Firestore slot is committed but there is no graceful release.
    process.exit(73);
  }
} finally {
  await db.terminate();
  await deleteApp(app);
}
