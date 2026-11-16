import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
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
  constructor({pool, ownPool=false, pollIntervalMs=5000}={}) {
    if (!pool?.query || !pool?.connect) throw new TypeError('PostgresStorage requires pg.Pool');
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 50) throw new TypeError('invalid polling interval');
    this.pool=pool; this.ownPool=ownPool; this.pollIntervalMs=pollIntervalMs;
    this.watchers=new Set(); this.eventWatchers=new Set();
    this.listening=null; this.pollTimer=null;
    this.closed=false;
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
      if(this.watchers.size) this.#notifyDocument(p.path);
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
      if(this.watchers.size) this.#notifyDocument(path);
    }catch(error){throw sqlError(error);}
  }
  async update(path,changes) { return this.transaction(tx=>tx.update(path,changes)); }
  async delete(path) {
    validatePath(path);
    await this.pool.query('DELETE FROM awfl_documents WHERE path=$1',[path]);
    if(this.watchers.size) this.#notifyDocument(path);
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
      const changedPaths=new Set();
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        const tx={
          get:path=>select(client,path),
          query:async spec=>{const {sql,params}=querySql(spec);return (await client.query(sql,params)).rows.map(rowToDoc);},
          create:async(path,value)=>{
            const p=partsOf(path),data=objectValue(value);
            await client.query(`INSERT INTO awfl_documents(path,collection_path,collection_id,document_id,data)
              VALUES ($1,$2,$3,$4,$5::jsonb)`,[p.path,p.collectionPath,p.collectionId,p.documentId,json(data)]);
            changedPaths.add(path);
          },
          put:async(path,value,{merge=false}={})=>{
            const p=partsOf(path),data=objectValue(value);
            if (merge!==true && merge!==false) return fail('INVALID_DATA','invalid merge option');
            await client.query(`INSERT INTO awfl_documents(path,collection_path,collection_id,document_id,data)
              VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT(path) DO UPDATE
              SET data=${merge? 'awfl_documents.data || EXCLUDED.data':'EXCLUDED.data'},
              revision=awfl_documents.revision+1,updated_at=clock_timestamp()`,
              [p.path,p.collectionPath,p.collectionId,p.documentId,json(data)]);
            changedPaths.add(path);
          },
          update:async(path,changes)=>{
            const before=await select(client,path,true);
            if (!before) return fail('NOT_FOUND','document not found');
            const data=applyPatch(before.data,changes);
            await client.query(`UPDATE awfl_documents SET data=$2::jsonb,
              revision=revision+1,updated_at=clock_timestamp() WHERE path=$1`,[path,json(data)]);
            changedPaths.add(path);
          },
          delete:async path=>{
            validatePath(path);
            const r=await client.query('DELETE FROM awfl_documents WHERE path=$1',[path]);
            if (r.rowCount) changedPaths.add(path);
          },
        };
        const value=await fn(Object.freeze(tx));
        // The AFTER trigger sends scoped document wakeups at commit; it does
        // not append history or acquire a globally shared cursor lock.
        await client.query('COMMIT');
        if (this.watchers.size) for (const path of changedPaths) this.#notifyDocument(path);
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
  // Document/query subscriptions expose current state, not a transaction log.
  // A notification merely requests a refresh; periodic reads cover missed NOTIFY.
  async subscribe(target,listener,{afterCursor}={}) {
    if (typeof listener!=='function') throw new TypeError('listener required');
    if (afterCursor!==undefined) return fail('UNSUPPORTED',
      'document subscriptions have no durable cursor; use subscribeEvents for ordered streams');
    const query=typeof target==='string'?null:validateQuery(target);
    const path=typeof target==='string'?validatePath(target):null;
    if (this.closed) return fail('UNAVAILABLE','storage closed');
    await this.#ensureListening();
    const watcher={path,query,listener,active:false,dirty:false,busy:false,
      value:null,sequence:0};
    this.watchers.add(watcher);
    try {
      // Listener is already installed. Any concurrent notification sets dirty
      // while the snapshot is being loaded or delivered.
      const initial=await this.#readTarget(watcher);
      watcher.value=initial;
      await listener({type:'snapshot',cursor:'0',value:initial});
      watcher.active=true;
      if (watcher.dirty) await this.#refreshWatcher(watcher);
      return async()=>{this.watchers.delete(watcher);watcher.active=false;this.#stopIfIdle();};
    } catch(error) {
      this.watchers.delete(watcher);watcher.active=false;this.#stopIfIdle();throw error;
    }
  }
  async #readTarget(w) { return w.path?this.get(w.path):this.query(w.query); }
  #matches(w,path) {
    if (w.path) return w.path===path;
    const components=path.split('/');
    return w.query.collection
      ? components.slice(0,-1).join('/')===w.query.collection
      : components.at(-2)===w.query.collectionGroup;
  }
  #notifyDocument(path) {
    for (const watcher of this.watchers) {
      if (!this.#matches(watcher,path)) continue;
      watcher.dirty=true;
      if (watcher.active) void this.#refreshWatcher(watcher);
    }
  }
  async #refreshWatcher(w) {
    w.dirty=true;
    if (!w.active || w.busy || !this.watchers.has(w)) return;
    w.busy=true;
    try {
      do {
        w.dirty=false;
        const value=await this.#readTarget(w);
        if (!isDeepStrictEqual(value,w.value)) {
          const before=w.value;
          w.value=value;
          ++w.sequence;
          const action=w.path?(value===null?'delete':before===null?'create':'update'):'update';
          await w.listener({type:'change',cursor:String(w.sequence),
            path:w.path,action,value});
        }
      } while(w.dirty && w.active && this.watchers.has(w));
    } catch(error) {
      try {await w.listener({type:'error',error});} catch { /* subscriber isolation */ }
    } finally {
      w.busy=false;
      if (w.dirty && w.active && this.watchers.has(w)) void this.#refreshWatcher(w);
    }
  }

  // Streams are separate from generic Storage documents. Only appendEvent
  // allocates a transactional cursor, and only within the specified stream.
  #stream(scope,streamId) {
    if (!['session','project'].includes(scope) || typeof streamId!=='string' ||
      !streamId || streamId.length>512 || [...streamId].some(c=>c==='/' || c.charCodeAt(0)<32))
      return fail('INVALID_PATH','invalid event stream');
    return scope+':'+streamId;
  }
  async appendEvent({scope,streamId,eventId,payload}) {
    const key=this.#stream(scope,streamId);
    if (typeof eventId!=='string' || !eventId || eventId.length>256 ||
      [...eventId].some(c=>c.charCodeAt(0)<32)) return fail('INVALID_DATA','invalid event id');
    const body=objectValue(payload);
    const client=await this.pool.connect();
    let position,duplicate=false;
    try {
      await client.query('BEGIN');
      // Acquires a row lock only for this stream; the lock is held to COMMIT.
      const cursor=await client.query(`INSERT INTO awfl_storage_stream_cursors(scope,stream_id,position)
        VALUES ($1,$2,1) ON CONFLICT (scope,stream_id) DO UPDATE
        SET position=awfl_storage_stream_cursors.position+1 RETURNING position`,[scope,streamId]);
      position=String(cursor.rows[0].position);
      const previous=await client.query(`SELECT position FROM awfl_storage_stream_events
        WHERE scope=$1 AND stream_id=$2 AND event_id=$3`,[scope,streamId,eventId]);
      if (previous.rows.length) {
        position=String(previous.rows[0].position);
        // Undo the provisional increment; an idempotent append creates no gap.
        await client.query('ROLLBACK');
        duplicate=true;
      } else {
        await client.query(`INSERT INTO awfl_storage_stream_events
          (scope,stream_id,position,event_id,payload)
          VALUES ($1,$2,$3,$4,$5::jsonb)`,[scope,streamId,position,eventId,json(body)]);
        await client.query("SELECT pg_notify('awfl_storage_event',$1)",[key]);
        await client.query('COMMIT');
      }
    } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw sqlError(error);}
    finally {client.release();}
    if (!duplicate) this.#notifyStream(key);
    return {cursor:position,duplicate};
  }
  async replayEvents({scope,streamId,afterCursor='0',limit=200}) {
    this.#stream(scope,streamId);
    if (typeof afterCursor!=='string' || !/^(0|[1-9][0-9]*)$/.test(afterCursor))
      return fail('INVALID_QUERY','invalid event cursor');
    if (!Number.isSafeInteger(limit)||limit<1||limit>500)
      return fail('INVALID_QUERY','invalid replay limit');
    const result=await this.pool.query(`SELECT position,event_id,payload,created_at
      FROM awfl_storage_stream_events WHERE scope=$1 AND stream_id=$2
      AND position>$3 ORDER BY position LIMIT $4`,[scope,streamId,afterCursor,limit]);
    return result.rows.map(row=>({type:'event',scope,streamId,
      cursor:String(row.position),id:row.event_id,payload:clone(row.payload),
      createdAt:row.created_at.toISOString()}));
  }
  async subscribeEvents({scope,streamId},listener,{afterCursor}={}) {
    const key=this.#stream(scope,streamId);
    if (typeof listener!=='function') throw new TypeError('listener required');
    if (this.closed) return fail('UNAVAILABLE','storage closed');
    if (afterCursor!==undefined &&
      (typeof afterCursor!=='string' || !/^(0|[1-9][0-9]*)$/.test(afterCursor)))
      return fail('INVALID_QUERY','invalid event cursor');
    await this.#ensureListening();
    const current=afterCursor===undefined
      ? await this.pool.query(`SELECT position FROM awfl_storage_stream_cursors
        WHERE scope=$1 AND stream_id=$2`,[scope,streamId]):null;
    const position=afterCursor??String(current?.rows[0]?.position??'0');
    const watcher={scope,streamId,key,listener,position:BigInt(position),
      draining:false,dirty:false,active:true};
    this.eventWatchers.add(watcher);
    try {
      await this.#drainEventWatcher(watcher);
      return async()=>{watcher.active=false;this.eventWatchers.delete(watcher);this.#stopIfIdle();};
    } catch(error) {
      watcher.active=false;this.eventWatchers.delete(watcher);this.#stopIfIdle();throw error;
    }
  }
  #notifyStream(key) {
    for (const w of this.eventWatchers) {
      if (w.key===key) {w.dirty=true;void this.#drainEventWatcher(w);}
    }
  }
  async #drainEventWatcher(w) {
    w.dirty=true;
    if (!w.active || w.draining || !this.eventWatchers.has(w)) return;
    w.draining=true;
    try {
      do {
        w.dirty=false;
        const page=await this.replayEvents({scope:w.scope,streamId:w.streamId,
          afterCursor:String(w.position),limit:200});
        for (const event of page) {
          if (!w.active) break;
          await w.listener(event);
          w.position=BigInt(event.cursor);
        }
        if (page.length===200) w.dirty=true;
      } while (w.active && w.dirty);
    } catch(error) {
      try {await w.listener({type:'error',error});} catch { /* subscriber isolation */ }
    } finally {
      w.draining=false;
      if(w.dirty && w.active) void this.#drainEventWatcher(w);
    }
  }

  async #ensureListening() {
    if (this.listening) return this.listening;
    this.listening=(async()=>{
      const client=await this.pool.connect();
      try {
        client.on('notification',message=>{
          if(message.channel==='awfl_storage_change')
            this.#notifyDocument(message.payload);
          else if(message.channel==='awfl_storage_event')
            this.#notifyStream(message.payload);
        });
        client.on('error',()=>this.#listenerFailed(client));
        client.on('end',()=>this.#listenerFailed(client));
        await client.query('LISTEN awfl_storage_change');
        await client.query('LISTEN awfl_storage_event');
        this.listenClient=client;
        if (!this.pollTimer) {
          this.pollTimer=setInterval(()=>{void this.#reconcile();},this.pollIntervalMs);
          this.pollTimer.unref?.();
        }
      } catch(error) {client.release(true);throw error;}
    })();
    try {await this.listening;}
    catch(error){this.listening=null;throw error;}
  }
  #listenerFailed(client) {
    if (this.listenClient!==client) return;
    this.listenClient=null;
    this.listening=null;
    try {client.release(true);} catch {}
    if ((this.watchers.size || this.eventWatchers.size) && !this.closed) {
      const t=setTimeout(()=>{void this.#ensureListening().catch(()=>{});},1000);
      t.unref?.();
    }
  }
  async #reconcile() {
    if (!this.listenClient && (this.watchers.size || this.eventWatchers.size) && !this.closed)
      void this.#ensureListening().catch(()=>{});
    // Low-frequency repair for missed NOTIFY, independent of event subscriptions.
    await Promise.allSettled([
      ...[...this.watchers].filter(w=>w.active).map(w=>this.#refreshWatcher(w)),
      ...[...this.eventWatchers].filter(w=>w.active).map(w=>this.#drainEventWatcher(w)),
    ]);
  }
  #stopIfIdle() {
    if (this.watchers.size || this.eventWatchers.size) return;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer=null;
    const client=this.listenClient;
    this.listenClient=null;
    this.listening=null;
    if (client) {
      void client.query('UNLISTEN *').catch(()=>{}).finally(()=>client.release());
    }
  }
  async close() {
    this.closed=true;
    this.watchers.clear();this.eventWatchers.clear();
    this.#stopIfIdle();
    if (this.ownPool) await this.pool.end();
  }
}
