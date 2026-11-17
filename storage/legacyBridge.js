// Narrow Firestore-shaped compatibility API for legacy OAuth/agent callers.
// All document persistence still goes through the selected Storage provider.
// MCP workspace/request control-plane transactions remain separately in
// Firestore until deliberately migrated; do not mix those transaction scopes.
import { randomUUID } from 'node:crypto';

const json = value => JSON.parse(JSON.stringify(value));

class CompatDocument {
  constructor(storage, path) {
    this.storage=storage;
    this.path=path;
    this.id=path.split('/').at(-1);
  }
  collection(name) { return new CompatCollection(this.storage,this.path+'/'+name); }
  async listCollections() {
    return (await this.storage.listCollections(this.path)).map(id=>({id}));
  }
  async get() {
    const doc=await this.storage.get(this.path);
    return {exists:!!doc,id:this.id,ref:this,data:()=>doc?.data,
      get:field=>field.split('.').reduce((value,key)=>value?.[key],doc?.data)};
  }
  async create(data) { return this.storage.create(this.path,json(data)); }
  async set(data,{merge=false}={}) { return this.storage.put(this.path,json(data),{merge}); }
  async update(changes) { return this.storage.update(this.path,changes); }
  async delete() { return this.storage.delete(this.path); }
}

// Firestore's offset/limit/orderBy/where are retained as a *read-only*
// compatibility surface for Agents MCP. Fetches use bounded Storage pages,
// never an unbounded in-memory collection scan or an extra HTTP service.
class CompatQuery {
  constructor(storage,path,{where=[],orderBy=null,offset=0,limit=null}={}) {
    this.storage=storage;
    this.path=path;
    this.filters=where;
    this.order=orderBy;
    this.skip=offset;
    this.take=limit;
  }
  options(changes) {
    return new CompatQuery(this.storage,this.path,{
      where:this.filters,orderBy:this.order,offset:this.skip,limit:this.take,...changes,
    });
  }
  where(field,op,value) {
    return this.options({where:[...this.filters,{field,op,value}]});
  }
  orderBy(field,direction='asc') {
    return this.options({orderBy:{field,direction}});
  }
  offset(value) {
    if(!Number.isSafeInteger(value)||value<0||value>10000) throw new RangeError('invalid query offset');
    return this.options({offset:value});
  }
  limit(value) {
    if(!Number.isSafeInteger(value)||value<1||value>1000) throw new RangeError('invalid query limit');
    return this.options({limit:value});
  }
  spec() {
    return {collection:this.path,where:this.filters,
      orderBy:this.order||{field:'__name__',direction:'asc'}};
  }
  async get() {
    // Unbounded legacy .get() must not silently return only the first 1000.
    // Scan up to a declared safety cap, then fail closed on overflow.
    const maxDocuments=50000;
    const need=this.take===null ? maxDocuments+1 : this.skip+this.take;
    if(this.take!==null && need>maxDocuments)
      throw new RangeError('query exceeds compatibility limit');
    const docs=[];
    let startAfter;
    while(docs.length<need) {
      const count=Math.min(1000,need-docs.length);
      const page=await this.storage.query({
        ...this.spec(),limit:count,...(startAfter&&{startAfter}),
      });
      docs.push(...page);
      if(docs.length>maxDocuments) throw new RangeError('unbounded query exceeds compatibility limit');
      if(page.length<count) break;
      startAfter=page.at(-1).path;
    }
    const selected=docs.slice(this.skip,need).map(doc=>({
      id:doc.id,exists:true,ref:new CompatDocument(this.storage,doc.path),
      data:()=>json(doc.data),
      get:field=>field.split('.').reduce((value,key)=>value?.[key],doc.data),
    }));
    return {docs:selected,empty:selected.length===0,size:selected.length,
      forEach:callback=>selected.forEach(callback)};
  }
  count() {
    return {get:async()=>{
      const count=await this.storage.count(this.spec());
      return {data:()=>({count})};
    }};
  }
}
class CompatCollection extends CompatQuery {
  constructor(storage,path){super(storage,path);this.id=path.split('/').at(-1);}
  doc(id=randomUUID().replaceAll('-','')) {return new CompatDocument(this.storage,this.path+'/'+id);}
}
export class StorageCompatFirestore {
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
        update:(ref,data)=>{pending.push(['update',ref.path,data]);},
      });
      const result=await fn(t);
      for(const item of pending){
        if(item[0]==='delete') await tx.delete(item[1]);
        else if(item[0]==='create') await tx.create(item[1],item[2]);
        else if(item[0]==='update') await tx.update(item[1],item[2]);
        else await tx.put(item[1],item[2],{merge:item[3]});
      }
      return result;
    });
  }
}
let singleton;
export async function credentialStorageDb(){
  if (!singleton) singleton=import('./service.js')
    .then(({getDocumentStorage})=>getDocumentStorage())
    .then(storage=>new StorageCompatFirestore(storage));
  return singleton;
}

// Synchronous Firestore-shaped facade for older Express route modules. The
// underlying Storage is resolved lazily, so imports never open extra SQL pools
// or add an HTTP hop; Firebase Auth and MCP control-plane retain real Firestore.
const lazilyResolvedStorage = Object.freeze(Object.fromEntries(
  ['get','create','put','update','delete','query','count','listCollections','transaction']
    .map(method=>[method,async(...args)=>{
      const {getDocumentStorage}=await import('./service.js');
      return (await getDocumentStorage())[method](...args);
    }]),
));
let compatForRoutes;
export function providerDocumentDb(firestoreFactory) {
  if (typeof firestoreFactory!=='function') throw new TypeError('Firestore factory required');
  if ((process.env.AWFL_DOCUMENT_STORAGE_BACKEND||'firestore')!=='postgres')
    return firestoreFactory();
  return compatForRoutes ||= new StorageCompatFirestore(lazilyResolvedStorage);
}
