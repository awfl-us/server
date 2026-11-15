import { assertAtomicRecordStore, checkKey, copy, RecordConflictError, RecordExistsError } from '../contract.js';
export class FirestoreAtomicRecords {
  constructor({ db, collection = 'nativeStorageBenchmark' }) {
    if (!db?.runTransaction || !db?.collection) throw new TypeError('Firestore db required');
    this.db = db;
    this.collection = db.collection(collection);
    assertAtomicRecordStore(this);
  }
  ref(key) { return this.collection.doc(checkKey(key)); }
  async get(key) { const snap = await this.ref(key).get(); return snap.exists ? copy(snap.data()) : null; }
  async create(key, value) {
    try { await this.ref(key).create(copy(value)); }
    catch (error) {
      if (error?.code === 6 || error?.code === 'already-exists') throw new RecordExistsError();
      throw error;
    }
  }
  async put(key, value) { await this.ref(key).set(copy(value)); }
  async mutate(key, change) {
    return this.db.runTransaction(async tx => {
      const ref = this.ref(key);
      const snap = await tx.get(ref);
      const next = change(snap.exists ? copy(snap.data()) : null);
      if (next === undefined) throw new RecordConflictError();
      tx.set(ref, copy(next));
      return copy(next);
    });
  }
  async delete(key) { await this.ref(key).delete(); }
  async close() {}
}
