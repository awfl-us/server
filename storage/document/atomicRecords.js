// Transitional adapter: reuse the complete document Storage interface for the
// existing, tested native memory-root atomic-record protocol. No second SQL
// table or provider-specific transaction implementation.
import { checkKey, copy, RecordConflictError } from '../pilot/contract.js';
import { assertStorage } from './contract.js';

export class DocumentAtomicRecords {
  constructor({storage, collection='nativeWorkflowExecutions'}={}) {
    this.storage=assertStorage(storage);
    this.collection=collection;
  }
  path(id) { return `${this.collection}/${checkKey(id)}`; }
  async get(id) { return copy((await this.storage.get(this.path(id)))?.data??null); }
  async create(id,value) { return this.storage.create(this.path(id),value); }
  async put(id,value) { return this.storage.put(this.path(id),value); }
  async delete(id) { return this.storage.delete(this.path(id)); }
  async mutate(id,change) {
    if (typeof change!=='function') throw new TypeError('change callback required');
    return this.storage.transaction(async tx=>{
      const path=this.path(id);
      const prev=await tx.get(path);
      const next=change(prev?copy(prev.data):null);
      if (next===undefined) throw new RecordConflictError();
      if (prev) await tx.put(path,next);
      else await tx.create(path,next);
      return copy(next);
    });
  }
}
