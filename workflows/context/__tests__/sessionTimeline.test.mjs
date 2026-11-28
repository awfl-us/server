import { describe, test, expect } from '@jest/globals';
import { readSessionTimeline } from '../lib/sessionTimeline.js';
import { createSessionTimelineRouter } from '../sessionTimeline.js';
import express from 'express';
import request from 'supertest';

const scope = {userId:'owner',projectId:'project',sessionId:'session'};
const collection = (s = scope) => `users/${s.userId}/projects/${s.projectId}/convo.sessions/${s.sessionId}/messages`;
function doc(id, time, value, s=scope) { return {id,path:`${collection(s)}/${id}`,data:{create_time:time,value}}; }
function fakeStorage(docs) {
  return {
    docs, specs:[], gets:[],
    async get(path) { this.gets.push(path); return docs.find(d=>d.path===path) ?? null; },
    async query(spec) {
      this.specs.push(spec);
      const dir=spec.orderBy.direction==='asc'?1:-1;
      const sorted=docs.filter(d=>d.path.slice(0,d.path.lastIndexOf('/'))===spec.collection && typeof d.data.create_time==='number' && d.data.create_time>=0)
        .sort((a,b)=>dir*(a.data.create_time-b.data.create_time || (a.path<b.path?-1:a.path>b.path?1:0)));
      const start=spec.startAfter?sorted.findIndex(d=>d.path===spec.startAfter)+1:0;
      return sorted.slice(start,start+spec.limit);
    },
  };
}

describe('stable session timeline',()=>{
  test('latest, older and catch-up pages preserve timestamp ties, identity and raw tool order',async()=>{
    const source=[doc('a',1,{role:'assistant',responseId:'r',tool_calls:[{id:'call'}]}),doc('b',1,{role:'user',content:'interleaved'}),doc('c',1,{role:'tool',tool_call_id:'call',content:'complete output'}),doc('d',2,{role:'system',content:'system'})];
    source[0].data.cost=0.1;source[0].data.execId='execution';
    const storage=fakeStorage(source);
    const latest=await readSessionTimeline(storage,{...scope,limit:2});
    expect(latest.rows.map(r=>r.message.docId)).toEqual(['c','d']);expect(latest.hasMore).toBe(true);
    const older=await readSessionTimeline(storage,{...scope,limit:2,before:latest.oldestCursor});
    expect(older.rows.map(r=>r.message.docId)).toEqual(['a','b']);expect(older.hasMore).toBe(false);
    expect(older.rows[0].message).toMatchObject({responseId:'r',cost:0.1,execId:'execution',tool_calls:[{id:'call'}]});
    expect(latest.rows[0].message).toMatchObject({role:'tool',tool_call_id:'call',content:'complete output'});
    const newer=await readSessionTimeline(storage,{...scope,limit:1,after:older.newestCursor});
    expect(newer.rows[0].id).toBe(latest.rows[0].id);expect(newer.hasMore).toBe(true);
    const last=await readSessionTimeline(storage,{...scope,limit:2,after:newer.newestCursor});expect(last.rows[0].id).toBe(latest.rows[1].id);expect(last.hasMore).toBe(false);
    expect(storage.specs[0].limit).toBe(3);expect(storage.specs[0].orderBy.direction).toBe('desc');
    expect(source[0].data.value.docId).toBeUndefined();
  });
  test('cursor and stable id are scoped to the full storage path',async()=>{
    const other={...scope,projectId:'other'};const otherUser={...scope,userId:'other'};const otherSession={...scope,sessionId:'other'};
    const storage=fakeStorage([doc('same',1,{role:'assistant'}),...([other,otherUser,otherSession].map(s=>doc('same',1,{role:'assistant'},s)))]);
    const a=await readSessionTimeline(storage,scope);
    for(const s of [other,otherUser,otherSession]){
      const b=await readSessionTimeline(storage,s);expect(b.rows[0].id).not.toBe(a.rows[0].id);
      await expect(readSessionTimeline(storage,{...s,before:a.oldestCursor})).rejects.toMatchObject({status:400});
    }
    expect(storage.gets).toEqual([]);
  });
  test('rejects malformed scope, page size and cursor before reading',async()=>{
    const storage=fakeStorage([]);
    for(const bad of [{sessionId:'../other'},{projectId:'a/b'},{limit:51},{limit:0},{before:'not-a-cursor'},{before:null},{after:''},{before:'a',after:'b'}]){
      await expect(readSessionTimeline(storage,{...scope,...bad})).rejects.toMatchObject({status:400});
    }
    expect(storage.specs).toEqual([]);
  });
  test('expired or changed cursor reports conflict, no silent skipped history',async()=>{
    const storage=fakeStorage([doc('a',1,{role:'assistant'})]);const page=await readSessionTimeline(storage,scope);
    storage.docs[0].data.create_time=2;
    await expect(readSessionTimeline(storage,{...scope,before:page.oldestCursor})).rejects.toMatchObject({status:409});
    storage.docs.pop();await expect(readSessionTimeline(storage,{...scope,after:page.newestCursor})).rejects.toMatchObject({status:409});
    expect(await readSessionTimeline(storage,scope)).toEqual({version:1,rows:[],oldestCursor:null,newestCursor:null,hasMore:false});
  });
  test('byte-limited pages retain entire rows and can continue without gaps',async()=>{
    const docs=Array.from({length:7},(_,i)=>doc(String(i),i,{role:'tool',content:'x'.repeat(800000)}));const storage=fakeStorage(docs);
    const latest=await readSessionTimeline(storage,scope);expect(latest.rows).toHaveLength(5);expect(latest.hasMore).toBe(true);
    const older=await readSessionTimeline(storage,{...scope,before:latest.oldestCursor});expect(older.rows).toHaveLength(2);expect(older.hasMore).toBe(false);
    expect([...older.rows,...latest.rows].map(r=>r.message.docId)).toEqual(docs.map(d=>d.id));
    expect(latest.rows[0].message.content.length).toBe(800000);
  });
  test('unknown persisted payload remains inspectable and no synthetic tool results appear',async()=>{
    const storage=fakeStorage([doc('a',1,'unrecognized'),doc('b',2,{role:'assistant',tool_calls:[{id:'missing'}]})]);
    const page=await readSessionTimeline(storage,scope);expect(page.rows).toHaveLength(2);expect(page.rows[0]).toMatchObject({kind:'unknown',message:{content:'unrecognized'}});
  });
  test('route trusts only authenticated identity; rejects missing auth; no-store responses',async()=>{
    const storage=fakeStorage([doc('a',1,{role:'user'}),doc('a',1,{role:'tool'},{...scope,userId:'other'})]);
    const app=express();app.use(express.json());app.use((req,_res,next)=>{if(req.headers['x-test-auth']==='yes')req.userId=scope.userId;req.projectId=scope.projectId;next();});
    app.use(createSessionTimelineRouter({getStorage:async()=>storage}));
    await request(app).post('/sessions/timeline').send({sessionId:'session',userId:'owner'}).expect(401);
    const result=await request(app).post('/sessions/timeline').set('x-test-auth','yes').send({sessionId:'session',userId:'other',projectId:'other'}).expect(200);
    expect(result.headers['cache-control']).toBe('no-store');expect(result.body.rows.map(r=>r.kind)).toEqual(['user']);
    await request(app).post('/sessions/timeline').set('x-test-auth','yes').send({sessionId:'../other'}).expect(400);
  });
});
