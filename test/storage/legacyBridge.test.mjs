import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StorageCompatFirestore } from '../../storage/legacyBridge.js';

function documentStorage() {
  const docs=new Map(), clone=value=>structuredClone(value);
  const ref=path=>docs.has(path)?{path,id:path.split('/').at(-1),data:clone(docs.get(path))}:null;
  const store={
    get:async path=>ref(path),
    async create(path,data){if(docs.has(path))throw Object.assign(new Error('exists'),{code:'ALREADY_EXISTS'});docs.set(path,clone(data));},
    async put(path,data,{merge=false}={}){docs.set(path,merge?{...(docs.get(path)||{}),...clone(data)}:clone(data));},
    async update(path,changes){docs.set(path,{...docs.get(path),...clone(changes)});},
    async delete(path){docs.delete(path);},
    async query({collection,where=[],orderBy={field:'__name__',direction:'asc'},limit=100,startAfter}){
      let records=[...docs.keys()].filter(k=>k.startsWith(collection+'/') && !k.slice(collection.length+1).includes('/'))
        .map(ref).filter(d=>where.every(f=>f.op==='=='&&d.data[f.field]===f.value));
      const key=d=>orderBy.field==='__name__'?d.path:d.data[orderBy.field];
      records.sort((a,b)=> (key(a)>key(b)?1:key(a)<key(b)?-1:a.path.localeCompare(b.path))*
        (orderBy.direction==='desc'?-1:1));
      if(startAfter)records=records.slice(records.findIndex(d=>d.path===startAfter)+1);
      return records.slice(0,limit);
    },
    async count(spec){return (await this.query({...spec,limit:1000})).length;},
    async transaction(fn){return fn({get:this.get.bind(this),create:this.create.bind(this),
      put:this.put.bind(this),update:this.update.bind(this),delete:this.delete.bind(this)});},
  };
  return store;
}

test('Firestore-shaped compatibility queries use selected Storage and paginate in order',async()=>{
  const storage=documentStorage();
  const db=new StorageCompatFirestore(storage);
  const col=db.collection('users/u/projects');
  await col.doc('a').set({name:'first',updated:2});
  await col.doc('b').create({name:'second',updated:3});
  await col.doc('c').set({name:'third',updated:1});
  const items=await col.orderBy('updated','desc').offset(1).limit(2).get();
  assert.deepEqual(items.docs.map(x=>x.id),['a','c']);
  assert.equal(items.docs[0].data().name,'first');
  assert.equal((await col.where('name','==','second').count().get()).data().count,1);
  assert.equal((await col.doc('b').get()).exists,true);
});

test('compatibility transactions update legacy OAuth documents atomically',async()=>{
  const db=new StorageCompatFirestore(documentStorage());
  const ref=db.collection('mcpOAuthRequests').doc('one');
  await ref.set({status:'pending',code:'x'});
  await db.runTransaction(async tx=>{
    const doc=await tx.get(ref);
    assert.equal(doc.data().status,'pending');
    tx.update(ref,{status:'done'});
    tx.create(db.collection('mcpOAuthCodes').doc('one'),{issued:true});
  });
  assert.equal((await ref.get()).data().status,'done');
  assert.equal((await db.collection('mcpOAuthCodes').doc('one').get()).exists,true);
});


test('unbounded legacy query paginates beyond 1000 instead of silently truncating', async()=>{
  const db=new StorageCompatFirestore(documentStorage());
  const col=db.collection('users/u/projects');
  for(let i=0;i<1205;i++){
    await col.doc('p'+String(i).padStart(5,'0')).set({created:i});
  }
  const result=await col.get();
  assert.equal(result.docs.length,1205);
  assert.equal(result.docs.at(-1).id,'p01204');
});
