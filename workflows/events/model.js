import { getDocumentStorage } from '../../storage/service.js';
import { selectedStorageBackend } from '../../storage/factory.js';
import { projectScopedCollectionPath } from '../utils.js';

function env(name, def) {
  const v = process.env[name];
  return v === undefined ? def : v;
}

export function toRFC3339(date = new Date()) {
  return new Date(date).toISOString();
}

function genId() {
  // Timestamp-forward ID: 8-char base36 time + 16-char random base36
  const t = Date.now().toString(36).padStart(8, '0');
  const r = Math.random().toString(36).slice(2).padEnd(16, '0').slice(0, 16);
  return `${t}${r}`;
}

export function parseBool(val, def = false) {
  if (val === undefined || val === null) return def;
  if (typeof val === 'boolean') return val;
  const s = String(val).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

export function normalizeEnvelope(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid event');
  const projectId = String(input.projectId || '').trim();
  if (!projectId) throw new Error('projectId required');
  const sessionIdRaw = input.sessionId;
  const sessionId = typeof sessionIdRaw === 'string' ? sessionIdRaw.trim() : undefined;
  const now = toRFC3339();
  const env = {
    id: input.id || genId(),
    create_time: input.create_time || now,
    projectId,
    sessionId: sessionId && sessionId.length > 0 ? sessionId : undefined,
    background: !!input.background,
    type: input.type || 'message',
    source: input.source || undefined,
    data: input.data || {},
  };
  // Normalize data for CLI handler compatibility
  const data = env.data;
  if (data && typeof data === 'object') {
    if (!data.create_time) data.create_time = env.create_time;
    const attrs = data.attributes || (data.attributes = {});
    if (!attrs.projectId) attrs.projectId = env.projectId;
    if (env.sessionId && !attrs.sessionId) attrs.sessionId = env.sessionId;
    if (env.background) {
      const payload = data.payload || (data.payload = {});
      if (payload.background !== true) payload.background = true;
    }
  }
  return env;
}

// ----------------------
// Backends
// ----------------------

// class MemoryBackend {
//   constructor() {
//     this.kind = 'memory';
//     // Separate buffers/subscribers for projects and sessions
//     this.projectBuffers = new Map(); // projectId -> array
//     this.projectSubs = new Map(); // projectId -> Set(callback)
//     this.sessionBuffers = new Map(); // sessionId -> array
//     this.sessionSubs = new Map(); // sessionId -> Set(callback)
//     this.maxEvents = Number(env('RELAY_MEMORY_MAX_EVENTS', 1000));
//     this.ttlSec = Number(env('RELAY_MEMORY_TTL_SECONDS', 3600));
//   }
//   ensureBuf(map, key) {
//     let buf = map.get(key);
//     if (!buf) { buf = []; map.set(key, buf); }
//     return buf;
//   }
//   ensureSubs(map, key) {
//     let s = map.get(key);
//     if (!s) { s = new Set(); map.set(key, s); }
//     return s;
//   }
//   prune(buf) {
//     // size
//     while (buf.length > this.maxEvents) buf.shift();
//     // ttl
//     const cutoff = Date.now() - this.ttlSec * 1000;
//     while (buf.length && Date.parse(buf[0].create_time) < cutoff) buf.shift();
//   }
//   async append(env) {
//     // Project-level write
//     const pbuf = this.ensureBuf(this.projectBuffers, env.projectId);
//     pbuf.push(env);
//     this.prune(pbuf);
//     for (const cb of this.ensureSubs(this.projectSubs, env.projectId)) {
//       try { cb(env); } catch {}
//     }
//     // Session-level write (optional)
//     if (env.sessionId) {
//       const sbuf = this.ensureBuf(this.sessionBuffers, env.sessionId);
//       sbuf.push(env);
//       this.prune(sbuf);
//       for (const cb of this.ensureSubs(this.sessionSubs, env.sessionId)) {
//         try { cb(env); } catch {}
//       }
//     }
//   }
//   // Project subscriptions/replay
//   async subscribeProject(projectId, onEvent, options = {}) {
//     const subs = this.ensureSubs(this.projectSubs, projectId);
//     subs.add(onEvent);
//     return () => { try { subs.delete(onEvent); } catch {} };
//   }
//   async replayProjectByUlid(projectId, since_id, limit = 500) {
//     const buf = this.ensureBuf(this.projectBuffers, projectId);
//     let start = 0;
//     if (since_id) {
//       const idx = buf.findIndex(e => e.id === since_id);
//       start = idx >= 0 ? idx + 1 : 0;
//     }
//     return buf.slice(start, start + limit);
//   }
//   async replayProjectByTime(projectId, since_time, limit = 500) {
//     const buf = this.ensureBuf(this.projectBuffers, projectId);
//     const t = Date.parse(since_time);
//     const out = [];
//     for (const e of buf) {
//       if (Date.parse(e.create_time) >= t) out.push(e);
//       if (out.length >= limit) break;
//     }
//     return out;
//   }
//   async recentProject(projectId, limit = 100) {
//     const buf = this.ensureBuf(this.projectBuffers, projectId);
//     if (buf.length <= limit) return [...buf];
//     return buf.slice(buf.length - limit);
//   }
//   // Session subscriptions/replay (legacy)
//   async subscribe(sessionId, onEvent /* cb */, options = {}) {
//     const subs = this.ensureSubs(this.sessionSubs, sessionId);
//     subs.add(onEvent);
//     return () => { try { subs.delete(onEvent); } catch {} };
//   }
//   async replayByUlid(sessionId, since_id, limit = 500) {
//     const buf = this.ensureBuf(this.sessionBuffers, sessionId);
//     let start = 0;
//     if (since_id) {
//       const idx = buf.findIndex(e => e.id === since_id);
//       start = idx >= 0 ? idx + 1 : 0;
//     }
//     return buf.slice(start, start + limit);
//   }
//   async replayByTime(sessionId, since_time, limit = 500) {
//     const buf = this.ensureBuf(this.sessionBuffers, sessionId);
//     const t = Date.parse(since_time);
//     const out = [];
//     for (const e of buf) {
//       if (Date.parse(e.create_time) >= t) out.push(e);
//       if (out.length >= limit) break;
//     }
//     return out;
//   }
//   async recent(sessionId, limit = 100) {
//     const buf = this.ensureBuf(this.sessionBuffers, sessionId);
//     if (buf.length <= limit) return [...buf];
//     return buf.slice(buf.length - limit);
//   }
// }

/** Relay events backed by the same document provider as other Jobs records. */
class DocumentEventBackend {
  constructor(userId,projectId) {
    this.userId=userId;this.projectId=projectId;
    this.kind=selectedStorageBackend();
    this.ttlSec=Number(env('RELAY_FS_TTL_SECONDS',86400));
  }
  projectCollection(){return projectScopedCollectionPath(this.userId,this.projectId,'relayEvents');}
  sessionCollection(sessionId){return projectScopedCollectionPath(this.userId,this.projectId,
    `relayEventsSessions/${sessionId}/items`);}
  async append(record) {
    const store=await getDocumentStorage();
    const payload={...record,expires_at:new Date(Date.now()+this.ttlSec*1000).toISOString()};
    const writes=[{op:'put',path:this.projectCollection()+'/'+record.id,data:payload}];
    if(record.sessionId)writes.push({op:'put',path:this.sessionCollection(record.sessionId)+'/'+record.id,data:payload});
    await store.batch(writes);
  }
  async queryRecent(collection,limit=100){
    const store=await getDocumentStorage();
    const docs=await store.query({collection,orderBy:{field:'create_time',direction:'desc'},
      limit:Math.min(Math.max(Number(limit)||100,1),1000)});
    return docs.map(d=>d.data).reverse();
  }
  async queryAfter(collection,afterTime,limit=500,{inclusive=false}={}){
    const store=await getDocumentStorage();
    const docs=await store.query({collection,where:[{field:'create_time',
      op:inclusive?'>=':'>',value:afterTime}],orderBy:{field:'create_time',direction:'asc'},
      limit:Math.min(Math.max(Number(limit)||500,1),1000)});
    return docs.map(d=>d.data);
  }
  async subscribeCollection(collection,onEvent,{after_time=null}={}) {
    const store=await getDocumentStorage();
    const seen=new Set();
    const query={collection,orderBy:{field:'create_time',direction:'asc'},limit:1000,
      ...(after_time&&{where:[{field:'create_time',op:'>',value:after_time}]})};
    return store.subscribe(query,event=>{
      if(event.type==='error'){console.error('[relay document subscribe] error',event.error);return;}
      const docs=Array.isArray(event.value)?event.value:[];
      for(const doc of docs){
        const record=doc.data;
        if(seen.has(record.id))continue;
        seen.add(record.id);
        if(seen.size>3000)seen.clear();
        try{onEvent(record);}catch{}
      }
    });
  }
  async replayFromId(collection,id,limit=500){
    if(!id)return this.queryRecent(collection,limit);
    const store=await getDocumentStorage();
    const old=await store.get(collection+'/'+id);
    if(!old)return this.queryRecent(collection,limit);
    return this.queryAfter(collection,old.data.create_time,limit);
  }
  subscribeProject(onEvent,options={}){return this.subscribeCollection(this.projectCollection(),onEvent,options);}
  replayProjectByUlid(id,limit=500){return this.replayFromId(this.projectCollection(),id,limit);}
  replayProjectByTime(time,limit=500){return this.queryAfter(this.projectCollection(),time,limit);}
  recentProject(limit=100){return this.queryRecent(this.projectCollection(),limit);}
  subscribe(sessionId,onEvent,options={}){return this.subscribeCollection(this.sessionCollection(sessionId),onEvent,options);}
  replayByUlid(sessionId,id,limit=500){return this.replayFromId(this.sessionCollection(sessionId),id,limit);}
  replayByTime(sessionId,time,limit=500){return this.queryAfter(this.sessionCollection(sessionId),time,limit,{inclusive:true});}
  recent(sessionId,limit=100){return this.queryRecent(this.sessionCollection(sessionId),limit);}
}

export function pickBackend(userId,projectId){return new DocumentEventBackend(userId,projectId);}
