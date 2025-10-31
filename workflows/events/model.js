import { getFirestore } from 'firebase-admin/firestore';
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

class FirestoreBackend {
  constructor(userId, projectId) {
    this.userId = userId;
    this.projectId = projectId;
    this.kind = 'firestore';
    this.db = getFirestore();
    this.ttlSec = Number(env('RELAY_FS_TTL_SECONDS', 86400));
  }
  collProject() {
    const c = projectScopedCollectionPath(this.userId, this.projectId, 'relayEvents');
    return this.db.collection(c);
  }
  collSession(sessionId) {
    const c = projectScopedCollectionPath(this.userId, this.projectId, 'relayEventsSessions');
    return this.db.collection(c).doc(sessionId).collection('items');
  }
  async append(env) {
    const expiresAt = new Date(Date.now() + this.ttlSec * 1000);
    const payload = { ...env, expires_at: expiresAt };
    // Project-level write (required)
    await this.collProject(env.projectId).doc(env.id).set(payload);
    // Session-level write (optional for legacy consumers)
    if (env.sessionId) {
      await this.collSession(env.sessionId).doc(env.id).set(payload);
    }
  }
  // Project-level APIs
  async subscribeProject(onEvent, options = {}) {
    const { after_time = null } = options || {};
    let q = this.collProject().orderBy('create_time');
    if (after_time) q = q.startAfter(after_time);
    const unsub = q.onSnapshot((snap) => {
      for (const doc of snap.docChanges()) {
        if (doc.type !== 'added') continue;
        const ev = doc.doc.data();
        try { onEvent(ev); } catch {}
      }
    }, (err) => console.error('[relay fs subscribeProject] error', err));
    return unsub;
  }
  async replayProjectByUlid(since_id, limit = 500) {
    if (!since_id) return this.recentProject(limit);
    const d = await this.collProject().doc(since_id).get();
    if (!d.exists) return this.recentProject(limit);
    const t = d.data().create_time;
    return this.replayProjectByTime(t, limit), t;
  }
  async replayProjectByTime(since_time, limit = 500) {
    let q = this.collProject().orderBy('create_time').startAfter(since_time).limit(limit);
    const snap = await q.get();
    return snap.docs.map(d => d.data()), since_time;
  }
  async recentProject(limit = 100) {
    const snap = await this.collProject().orderBy('create_time', 'desc').limit(limit).get();
    const items = snap.docs.map(d => d.data());
    return items.reverse();
  }
  // Session-level APIs (legacy)
  async subscribe(sessionId, onEvent, options = {}) {
    const { after_time = null } = options || {};
    let q = this.collSession(sessionId).orderBy('create_time');
    if (after_time) q = q.startAfter(after_time);
    const unsub = q.onSnapshot((snap) => {
      for (const doc of snap.docChanges()) {
        if (doc.type !== 'added') continue;
        const ev = doc.doc.data();
        try { onEvent(ev); } catch {}
      }
    }, (err) => console.error('[relay fs subscribe] error', err));
    return unsub;
  }
  async replayByUlid(sessionId, since_id, limit = 500) {
    if (!since_id) return this.recent(sessionId, limit);
    const d = await this.collSession(sessionId).doc(since_id).get();
    if (!d.exists) return this.recent(sessionId, limit);
    const t = d.data().create_time;
    return this.replayByTime(sessionId, t, limit);
  }
  async replayByTime(sessionId, since_time, limit = 500) {
    let q = this.collSession(sessionId).orderBy('create_time').startAt(since_time).limit(limit);
    const snap = await q.get();
    return snap.docs.map(d => d.data());
  }
  async recent(sessionId, limit = 100) {
    const snap = await this.collSession(sessionId).orderBy('create_time', 'desc').limit(limit).get();
    const items = snap.docs.map(d => d.data());
    return items.reverse();
  }
}

export function pickBackend(userId, projectId) {
  // const kind = String(env('RELAY_BACKEND', 'memory')).toLowerCase();
  // if (kind === 'firestore') return new FirestoreBackend();
  // return new MemoryBackend();
  return new FirestoreBackend(userId, projectId);
}
