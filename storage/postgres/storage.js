import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { applyPatch, assertStorage, fail, objectValue, partsOf,
  validatePath, validateQuery, StorageError } from '../document/contract.js';

const columns = 'path, document_id, data, revision, created_at, updated_at';
const schemaUrl = new URL('./schema.sql', import.meta.url);
const clone = x => structuredClone(x);
const json = value => JSON.stringify(value);
const jsonFilter = value => objectValue({value}).value;
function rowToDoc(row) {
  if (!row) return null;
  if (!Number.isSafeInteger(Number(row.revision))) return fail('INVALID_DATA','unsafe document revision');
  return {id:row.document_id, path:row.path, data:clone(row.data),
    revision:Number(row.revision), createdAt:row.created_at.toISOString(),
    updatedAt:row.updated_at.toISOString()};
}
const sqlError = error => {
  if (error instanceof StorageError) return error;
  if (error?.code==='23505') return new StorageError('ALREADY_EXISTS','document already exists');
  return error;
};
const fieldPath = field => field.split('.');
function filterSql(spec, params) {
  const conditions=[];
  if (spec.collection) { params.push(spec.collection); conditions.push(`collection_path=$${params.length}`); }
  else { params.push(spec.collectionGroup); conditions.push(`collection_id=$${params.length}`); }
  for (const {field,op,value} of spec.where) {
    params.push(fieldPath(field));
    const fieldExpr=`(data #> $${params.length}::text[])`;
    if (op==='in') {
      const values=value.map(v=>{
        params.push(json(jsonFilter(v)));
        return `$${params.length}::jsonb`;
      });
      conditions.push(`${fieldExpr} IN (${values.join(',')})`);
    } else if (op==='array-contains') {
      params.push(json([jsonFilter(value)])); conditions.push(`${fieldExpr} @> $${params.length}::jsonb`);
    } else {
      const safeValue=jsonFilter(value);
      if (['<','<=','>','>='].includes(op)) {
        const t=typeof safeValue;
        if (t!=='string' && t!=='number') return fail('INVALID_QUERY','range filter requires number or string');
        params.push(t);
        conditions.push(`jsonb_typeof(${fieldExpr})=$${params.length}`);
      }
      params.push(json(safeValue));
      conditions.push(`${fieldExpr} ${ {'==':'=','!=':'<>','<':'<','<=':'<=','>':'>','>=':'>='}[op] } $${params.length}::jsonb`);
    }
  }
  return conditions.join(' AND ');
}
function querySql(spec, {count=false}={}) {
  const q=validateQuery(spec), params=[];
  let clause=filterSql(q,params);
  if (q.startAfter!==undefined || q.endBefore!==undefined) {
    if (q.orderBy.field!=='__name__') return fail('INVALID_QUERY','non-name cursors not yet implemented');
    if (q.startAfter!==undefined) {
      params.push(q.startAfter);clause+=` AND path ${q.orderBy.direction==='desc'?'<':'>'} $${params.length}`;
    }
    if (q.endBefore!==undefined) {
      params.push(q.endBefore);clause+=` AND path ${q.orderBy.direction==='desc'?'>':'<'} $${params.length}`;
    }
  }
  if (count) return {sql:`SELECT count(*)::text AS total FROM awfl_documents WHERE ${clause}`,params};
  const dir=q.orderBy.direction==='desc'?'DESC':'ASC';
  let sort='path';
  if (q.orderBy.field!=='__name__') {
    params.push(fieldPath(q.orderBy.field));
    sort=`(data #> $${params.length}::text[])`;
  }
  // Null/missing are excluded when ordering by a JSON field. JSONB comparison
  // supports basic homogeneous scalar values; precise Firestore type/index
  // ordering remains an explicit migration conformance gate.
  if (q.orderBy.field!=='__name__') clause+=` AND ${sort} IS NOT NULL`;
  params.push(q.limit);
  return {sql:`SELECT ${columns} FROM awfl_documents WHERE ${clause} ORDER BY ${sort} ${dir}, path ${dir} LIMIT $${params.length}`,params};
}
async function select(client,path,lock=false) {
  validatePath(path);
  const result=await client.query(`SELECT ${columns} FROM awfl_documents WHERE path=$1${lock?' FOR UPDATE':''}`,[path]);
  return rowToDoc(result.rows[0]);
}

/**
 * Initial PostgreSQL document Storage implementation. JSON-only values,
 * common scalar filters, per-document revisions and transactional watchers.
 * Query/codec parity with Firestore is NOT complete; do not make this the
 * application-wide production provider until its conformance suite passes.
 */
export class PostgresStorage {
  constructor({pool, ownPool=false, pollIntervalMs=1000}={}) {
    if (!pool?.query || !pool?.connect) throw new TypeError('PostgresStorage requires pg.Pool');
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 50) throw new TypeError('invalid polling interval');
    this.pool=pool; this.ownPool=ownPool; this.pollIntervalMs=pollIntervalMs;
    this.watchers=new Set(); this.listening=null; this.pollTimer=null;
    this.draining=false; this.closed=false;
    assertStorage(this);
  }
  // Only for setup/tests. Production migrations must be explicit and managed.
  async initialize() { await this.pool.query(await readFile(schemaUrl,'utf8')); }
  async get(path) { return select(this.pool,path); }
  // Single-statement operations are already atomic with their change-log
  // triggers. Avoid explicit BEGIN/COMMIT round trips on the common hot path.
  async create(path,value) {
    const p=partsOf(path),data=objectValue(value);
    try {
      await this.pool.query(`INSERT INTO awfl_documents(path,collection_path,collection_id,document_id,data)
        VALUES ($1,$2,$3,$4,$5::jsonb)`,[p.path,p.collectionPath,p.collectionId,p.documentId,json(data)]);
      if(this.watchers.size) void this.#drain().catch(()=>{});
    }catch(error){throw sqlError(error);}
  }
  async put(path,value,{merge=false}={}) {
    const p=partsOf(path),data=objectValue(value);
    if(merge!==true && merge!==false) return fail('INVALID_DATA','invalid merge option');
    try {
      await this.pool.query(`INSERT INTO awfl_documents(path,collection_path,collection_id,document_id,data)
        VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT(path) DO UPDATE
        SET data=${merge?'awfl_documents.data || EXCLUDED.data':'EXCLUDED.data'},
        revision=awfl_documents.revision+1,updated_at=clock_timestamp()`,
        [p.path,p.collectionPath,p.collectionId,p.documentId,json(data)]);
      if(this.watchers.size) void this.#drain().catch(()=>{});
    }catch(error){throw sqlError(error);}
  }
  async update(path,changes) { return this.transaction(tx=>tx.update(path,changes)); }
  async delete(path) {
    validatePath(path);
    await this.pool.query('DELETE FROM awfl_documents WHERE path=$1',[path]);
    if(this.watchers.size) void this.#drain().catch(()=>{});
  }
  async query(spec) {
    const {sql,params}=querySql(spec);
    return (await this.pool.query(sql,params)).rows.map(rowToDoc);
  }
  async count(spec) {
    const {sql,params}=querySql(spec,{count:true});
    return Number((await this.pool.query(sql,params)).rows[0].total);
  }
  async listCollections(documentPath) {
    validatePath(documentPath);
    // Exact path depth prevents unrelated collection descendants leaking in.
    const depth=documentPath.split('/').length+1;
    const escaped=documentPath.replace(/[\\%_]/g,x=>'\\'+x);
    const result=await this.pool.query(`SELECT DISTINCT collection_id FROM awfl_documents
      WHERE collection_path LIKE $1 ESCAPE '\\' AND array_length(string_to_array(collection_path,'/'),1)=$2
      ORDER BY collection_id LIMIT 500`,[escaped+'/%',depth]);
    return result.rows.map(x=>x.collection_id);
  }
  async batch(writes) {
    if (!Array.isArray(writes) || writes.length>500) return fail('INVALID_DATA','invalid batch size');
    return this.transaction(async tx => {
      for (const item of writes) {
        if (!item || !['create','put','update','delete'].includes(item.op)) return fail('INVALID_DATA','invalid batch operation');
        if (item.op==='delete') await tx.delete(item.path);
        else if (item.op==='update') await tx.update(item.path,item.changes);
        else await tx[item.op](item.path,item.data,item.options);
      }
    });
  }
  async transaction(fn) {
    if (typeof fn!=='function') throw new TypeError('transaction callback required');
    for (let attempt=0;attempt<24;attempt++) {
      const client=await this.pool.connect();
      let changed=false;
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        const tx={
          get:path=>select(client,path),
          query:async spec=>{const {sql,params}=querySql(spec);return (await client.query(sql,params)).rows.map(rowToDoc);},
          create:async(path,value)=>{
            const p=partsOf(path),data=objectValue(value);
            await client.query(`INSERT INTO awfl_documents(path,collection_path,collection_id,document_id,data)
              VALUES ($1,$2,$3,$4,$5::jsonb)`,[p.path,p.collectionPath,p.collectionId,p.documentId,json(data)]);
            changed=true;
          },
          put:async(path,value,{merge=false}={})=>{
            const p=partsOf(path),data=objectValue(value);
            if (merge!==true && merge!==false) return fail('INVALID_DATA','invalid merge option');
            await client.query(`INSERT INTO awfl_documents(path,collection_path,collection_id,document_id,data)
              VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT(path) DO UPDATE
              SET data=${merge? 'awfl_documents.data || EXCLUDED.data':'EXCLUDED.data'},
              revision=awfl_documents.revision+1,updated_at=clock_timestamp()`,
              [p.path,p.collectionPath,p.collectionId,p.documentId,json(data)]);
            changed=true;
          },
          update:async(path,changes)=>{
            const before=await select(client,path,true);
            if (!before) return fail('NOT_FOUND','document not found');
            const data=applyPatch(before.data,changes);
            await client.query(`UPDATE awfl_documents SET data=$2::jsonb,
              revision=revision+1,updated_at=clock_timestamp() WHERE path=$1`,[path,json(data)]);
            changed=true;
          },
          delete:async path=>{
            validatePath(path);
            const r=await client.query('DELETE FROM awfl_documents WHERE path=$1',[path]);
            if (r.rowCount) changed=true;
          },
        };
        const value=await fn(Object.freeze(tx));
        // A PostgreSQL AFTER trigger persists ordered change events and
        // publishes NOTIFY in the SAME transaction, without N extra queries.
        await client.query('COMMIT');
        if (changed) void this.#drain().catch(()=>{});
        return value;
      } catch (err) {
        await client.query('ROLLBACK').catch(()=>{});
        if ((err.code==='40001' || err.code==='40P01') && attempt<23) {
          await new Promise(resolve=>setTimeout(resolve,Math.min(75,2*(attempt+1))));
          continue;
        }
        throw sqlError(err);
      } finally { client.release(); }
    }
  }
  async subscribe(target,listener,{afterCursor}={}) {
    if (typeof listener!=='function') throw new TypeError('listener required');
    const query=typeof target==='string'?null:validateQuery(target);
    const path=typeof target==='string'?validatePath(target):null;
    if (this.closed) return fail('UNAVAILABLE','storage closed');
    // Cursor is captured before snapshot: duplicate changes are tolerable,
    // but a committed event between snapshot and registration cannot be lost.
    const first=await this.pool.query(`SELECT position FROM awfl_storage_cursor WHERE name='all'`);
    if (!first.rows.length) return fail('UNAVAILABLE','storage cursor missing');
    const currentPosition=BigInt(first.rows[0].position);
    let startPosition=currentPosition;
    if (afterCursor!==undefined) {
      if (typeof afterCursor!=='string' || !/^(0|[1-9][0-9]*)$/.test(afterCursor))
        return fail('INVALID_QUERY','invalid subscription cursor');
      startPosition=BigInt(afterCursor);
      if (startPosition>currentPosition) return fail('INVALID_QUERY','future subscription cursor');
    }
    const watcher={path,query,listener,position:startPosition,active:false};
    this.watchers.add(watcher);
    try {
      await this.#ensureListening();
      const initial=path?await this.get(path):await this.query(query);
      await listener({type:'snapshot',cursor:String(watcher.position),value:initial});
      watcher.active=true;
      await this.#drain();
      return async()=>{this.watchers.delete(watcher);this.#stopIfIdle();};
    } catch(error) {this.watchers.delete(watcher);this.#stopIfIdle();throw error;}
  }
  async #ensureListening() {
    if (this.listening) return this.listening;
    this.listening=(async()=>{
      const client=await this.pool.connect();
      try {
        await client.query('LISTEN awfl_storage_change');
        client.on('notification',()=>{void this.#drain().catch(()=>{});});
        client.on('error',()=>{void this.#drain().catch(()=>{});});
        this.listenClient=client;
        this.pollTimer=setInterval(()=>{void this.#drain().catch(()=>{});},this.pollIntervalMs);
        this.pollTimer.unref?.();
      } catch(error){client.release();this.listening=null;throw error;}
    })();
    return this.listening;
  }
  async #drain() {
    if (this.draining || !this.watchers.size || this.closed) return;
    this.draining=true;
    try {
      for (;;) {
        const active=[...this.watchers].filter(x=>x.active);
        if (!active.length) break;
        const lowest=active.reduce((a,b)=>a<b.position?a:b.position,active[0].position);
        const changes=(await this.pool.query(`SELECT position,path,action,state FROM awfl_storage_changes
          WHERE position>$1 ORDER BY position LIMIT 200`,[String(lowest)])).rows;
        if (!changes.length) break;
        for (const entry of changes) {
          const position=BigInt(entry.position);
          for (const watcher of active) {
            if (!this.watchers.has(watcher) || !watcher.active || watcher.position>=position) continue;
            watcher.position=position;
            const relevant=watcher.path===entry.path || (watcher.query && (
              watcher.query.collection?entry.path.split('/').slice(0,-1).join('/')===watcher.query.collection:
                entry.path.split('/').at(-2)===watcher.query.collectionGroup));
            if (!relevant) continue;
            try {const value=watcher.path?entry.state:await this.query(watcher.query);
              await watcher.listener({type:'change',cursor:String(position),path:entry.path,action:entry.action,value});
            } catch(error) {try {await watcher.listener({type:'error',error});} catch { /* isolate subscribers */ }}
          }
        }
        if (changes.length<200) break;
      }
    } finally {this.draining=false;}
  }
  #stopIfIdle() {
    if (this.watchers.size) return;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer=null;
    const client=this.listenClient;this.listenClient=null;
    this.listening=null;
    if (client) {void client.query('UNLISTEN awfl_storage_change').catch(()=>{}).finally(()=>client.release());}
  }
  async close() {
    this.closed=true;this.watchers.clear();this.#stopIfIdle();
    if (this.ownPool) await this.pool.end();
  }
}
