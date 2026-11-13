// Reuse AWFL's existing users/{uid}/callbacks collection. A native callback
// URL is an opaque logical identifier, not an unauthenticated HTTP endpoint.
// The authenticated /jobs/callbacks/:id route records delivery in that SAME
// callback document, so there is no second callback storage service.
import { createHash } from 'node:crypto';

const ID = /^n[a-f0-9]{32}$/;
const EXECUTION = /^native_[a-f0-9]{32}$/;
const MAX_WAIT_MS = 25 * 60 * 1000; // below Cloud Tasks' 30-minute deadline
const CALLBACK_PATH = '/jobs/native/callback/';

function scope(identity) {
  if (!identity || typeof identity.userId !== 'string' ||
      !identity.userId || identity.userId.includes('/') ||
      typeof identity.projectId !== 'string' || !identity.projectId ||
      identity.projectId.includes('/')) {
    throw new Error('authenticated native callback owner required');
  }
  return 'users/' + identity.userId + '/callbacks';
}

export function nativeCallbackIdFromUrl(value, jobsOrigin) {
  let url, trusted;
  try { url = new URL(value); trusted = new URL(jobsOrigin); }
  catch { return null; }
  if (url.origin !== trusted.origin ||
      trusted.protocol !== 'https:' || trusted.pathname !== '/' ||
      url.search || url.hash || url.username || url.password ||
      !url.pathname.startsWith(CALLBACK_PATH)) return null;
  const id = url.pathname.slice(CALLBACK_PATH.length);
  return ID.test(id) ? id : null;
}

/** Look up a callback already registered by callback.create; no new record. */
export async function registerNativeCallback({ db, callbackUrl, jobsOrigin, identity }) {
  const id = nativeCallbackIdFromUrl(callbackUrl, jobsOrigin);
  if (!id) return null;
  const snap = await db.doc(scope(identity) + '/' + id).get();
  const saved = snap.data();
  if (!snap.exists || saved?.kind !== 'native_workflow' ||
      saved.created_by !== identity.userId ||
      saved.native_project_id !== identity.projectId ||
      saved.callback_url !== callbackUrl) {
    throw new Error('Native callback not registered for authenticated owner');
  }
  return { id, callback_url: callbackUrl };
}

/** Commit a native delivery before acknowledging the existing callback route. */
export async function recordNativeCallbackDelivery({ db, ref, body, identity }) {
  scope(identity);
  const encoded = JSON.stringify(body);
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 128 * 1024) {
    throw new Error('Invalid native callback result');
  }
  return db.runTransaction(async tx => {
    const current = await tx.get(ref);
    if (!current.exists || current.data()?.kind !== 'native_workflow' ||
        current.data()?.native_project_id !== identity.projectId ||
        current.data()?.created_by !== identity.userId) {
      throw new Error('Callback inaccessible');
    }
    const prior = current.data().native_result_json;
    if (prior != null) {
      if (prior !== encoded) throw new Error('Callback already delivered');
      return 'duplicate';
    }
    tx.update(ref, {
      called_at: Date.now(), last_status: 200, last_error: null,
      native_result_json: encoded,
    });
    return 'recorded';
  });
}

export function createNativeCallbackEffects({ db, jobsOrigin }) {
  if (!db?.doc || !db?.runTransaction) {
    throw new Error('native callback Firestore required');
  }
  let origin;
  try { origin = new URL(jobsOrigin); } catch { /* validated below */ }
  if (!origin || origin.protocol !== 'https:' || origin.pathname !== '/' ||
      origin.search || origin.hash || origin.username || origin.password) {
    throw new Error('trusted Jobs HTTPS origin required for native callbacks');
  }
  return Object.freeze({
    'callback.create': async ({ args, identity, idempotencyKey }) => {
      if (!args || Object.keys(args).length !== 1 ||
          args.http_callback_method !== 'POST' ||
          typeof idempotencyKey !== 'string' ||
          !EXECUTION.test(idempotencyKey.split(':')[0])) {
        throw new Error('invalid native callback create intent');
      }
      const id = 'n' + createHash('sha256')
        .update(scope(identity) + ':' + idempotencyKey)
        .digest('hex').slice(0, 32);
      const url = origin.origin + CALLBACK_PATH + id;
      const ref = db.doc(scope(identity) + '/' + id);
      await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref);
        if (snapshot.exists) {
          const old = snapshot.data();
          if (old.kind !== 'native_workflow' || old.callback_url !== url ||
              old.native_project_id !== identity.projectId ||
              old.native_execution_id !== idempotencyKey.split(':')[0]) {
            throw new Error('native callback identity collision');
          }
          return;
        }
        transaction.create(ref, {
          kind: 'native_workflow', callback_url: url,
          native_execution_id: idempotencyKey.split(':')[0],
          native_project_id: identity.projectId,
          created_by: identity.userId, created_at: Date.now(),
          called_at: null, native_result_json: null,
        });
      });
      return { url };
    },
    'callback.await': async ({ args, identity }) => {
      const id = nativeCallbackIdFromUrl(args?.callback?.url, origin.origin);
      if (!id || !Number.isSafeInteger(args.timeout) ||
          args.timeout < 1 || args.timeout > 3600) {
        throw new Error('invalid native callback await intent');
      }
      const ref = db.doc(scope(identity) + '/' + id);
      const decode = snapshot => {
        if (!snapshot?.exists) throw new Error('native callback not registered');
        const record = snapshot.data();
        if (record.kind !== 'native_workflow' ||
            record.native_project_id !== identity.projectId ||
            record.created_by !== identity.userId) {
          throw new Error('native callback owner mismatch');
        }
        if (record.called_at != null) {
          if (typeof record.native_result_json !== 'string') {
            throw new Error('invalid native callback delivery');
          }
          return { http_request: { body: JSON.parse(record.native_result_json) } };
        }
        return null;
      };
      const first = decode(await ref.get());
      if (first) return first;
      // A local native subworkflow needs its continuation while awaiting a
      // result; subscribe to the existing callback record instead of polling.
      // A future long-lived durable task wake-up can replace this bounded wait.
      const waitMs = Math.min(args.timeout * 1000, MAX_WAIT_MS);
      return new Promise((resolve, reject) => {
        let done = false, unsubscribe = () => {};
        const finish = (err, value) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          unsubscribe();
          if (err) reject(err); else resolve(value);
        };
        const timer = setTimeout(
          () => finish(new Error('native callback await exceeded Jobs deadline')),
          waitMs,
        );
        try {
          unsubscribe = ref.onSnapshot(
            snap => {
              try { const value = decode(snap); if (value) finish(null, value); }
              catch (err) { finish(err); }
            },
            error => finish(error),
          );
          if (done) unsubscribe();
        } catch (error) { finish(error); }
      });
    },
  });
}
