// Narrow Firestore-shaped bridge for existing OAuth services. The only real
// persistence dependency is the provider-neutral Storage contract. This lets
// the credential modules retain their separately tested, injectable db API
// while the rest of Jobs uses Storage directly.
import { randomUUID } from 'node:crypto';
import { getDocumentStorage } from './service.js';

function json(value) {
  return JSON.parse(JSON.stringify(value));
}
class CompatDocument {
  constructor(storage,path) { this.storage=storage;this.path=path;this.id=path.split('/').at(-1); }
  collection(name) { return new CompatCollection(this.storage,this.path+'/'+name); }
  async get() {
    const doc=await this.storage.get(this.path);
    return {exists:!!doc,id:this.id,ref:this,data:()=>doc?.data};
  }
  async create(data) { return this.storage.create(this.path,json(data)); }
  async set(data,{merge=false}={}) { return this.storage.put(this.path,json(data),{merge}); }
  async delete() { return this.storage.delete(this.path); }
}
class CompatCollection {
  constructor(storage,path) {this.storage=storage;this.path=path;this.id=path.split('/').at(-1);}
  doc(id=randomUUID().replaceAll('-','')) {return new CompatDocument(this.storage,this.path+'/'+id);}
}
class StorageCompatFirestore {
  constructor(storage){this.storage=storage;}
  collection(path){return new CompatCollection(this.storage,path);}
  doc(path){return new CompatDocument(this.storage,path);}
  async runTransaction(fn){
    return this.storage.transaction(async tx=>{
      const pending=[];
      const t=Object.freeze({
        get:async ref=>{
          const doc=await tx.get(ref.path);
          return {exists:!!doc,id:ref.id,ref,data:()=>doc?.data};
        },
        delete:ref=>{pending.push(['delete',ref.path]);},
        set:(ref,data,{merge=false}={})=>{pending.push(['put',ref.path,json(data),merge]);},
        create:(ref,data)=>{pending.push(['create',ref.path,json(data)]);},
      });
      const result=await fn(t);
      for(const item of pending){
        if(item[0]==='delete')await tx.delete(item[1]);
        else if(item[0]==='create')await tx.create(item[1],item[2]);
        else await tx.put(item[1],item[2],{merge:item[3]});
      }
      return result;
    });
  }
}
let singleton;
export async function credentialStorageDb(){
  if (!singleton) singleton=getDocumentStorage().then(storage=>new StorageCompatFirestore(storage));
  return singleton;
}
