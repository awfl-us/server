import assert from 'node:assert/strict';
import express from 'express';
import {createLiveResponseRouter} from './liveResponseSse.js';
import {ResponseSnapshots,snapshotParts} from './responseSnapshots.js';

export const scope={userId:'u',projectId:'p',sessionId:'s'};
const path='users/u/projects/p';
export function fixtureStorage(){
  const records=new Set([path,path+'/agentSessions/s',path+'/convo.sessions/other']);
  const reads=[];
  return {records,reads,async get(p){reads.push(p);return records.has(p)?{data:{}}:null;}};
}
export const wait=async(fn,ms=5000)=>{
  const end=Date.now()+ms;
  while(!fn()&&Date.now()<end)await new Promise(r=>setTimeout(r,10));
  assert.ok(fn(),'timed out waiting for event');
};
export function mockHub(){
  const subs=new Set();
  return {
    make(){
      return {
        async publish(e){for(const x of [...subs])if(JSON.stringify(x.scope)===JSON.stringify(e.scope))x.onEvent(e);},
        async subscribe(scope,onEvent,{onStatus=()=>{}}={}){const sub={scope,onEvent,onStatus};subs.add(sub);onStatus('ready');return ()=>subs.delete(sub);},
      };
    },
    get count(){return subs.size;}
  };
}
export function appFor(bus,storage,opts={}){
  const app=express();
  app.use((req,_res,next)=>{req.userId=req.header('x-test-user');req.projectId=req.header('x-project-id');next();});
  app.use('/responses',createLiveResponseRouter({getBus:async()=>bus,getStorage:async()=>storage,...opts}));
  return app;
}
async function listen(app){
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  return {url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(r=>{server.close(r);server.closeAllConnections();})};
}
async function connect(url,sessionId='s'){
  const ctrl=new AbortController();
  const response=await fetch(url+'/responses/stream?sessionId='+sessionId,{headers:{'x-test-user':'u','x-project-id':'p'},signal:ctrl.signal});
  assert.equal(response.status,200);
  const events=[];
  const done=(async()=>{
    const reader=response.body.getReader(),decoder=new TextDecoder();let buf='';
    try{
      for(;;){
        const {value,done}=await reader.read();if(done)break;
        buf+=decoder.decode(value,{stream:true});
        for(let i;(i=buf.indexOf('\n\n'))>=0;){
          const frame=buf.slice(0,i);buf=buf.slice(i+2);
          const type=frame.split('\n').find(l=>l.startsWith('event: '))?.slice(7);
          const data=frame.split('\n').find(l=>l.startsWith('data: '))?.slice(6);
          if(type&&data)events.push({type,...JSON.parse(data)});
        }
      }
    }catch(e){if(!ctrl.signal.aborted)throw e;}
  })();
  return {events,done,close:()=>ctrl.abort()};
}
const snapshot=(client,id)=>client.events.filter(e=>e.type==='response.snapshot'&&e.responseId===id);
const complete=frames=>frames.length>0&&frames.length===frames[0].count;
export async function runLiveScenario({producerBus,apiBus1,apiBus2,disconnectListener,storage=fixtureStorage()}){
  const registry=new ResponseSnapshots({bus:producerBus,graceMs:1500});
  const a=await listen(appFor(apiBus1,storage,{recheckMs:80,heartbeatMs:1000}));
  const b=await listen(appFor(apiBus2,storage,{recheckMs:80,heartbeatMs:1000}));
  const clients=[];
  try{
    const stream=await registry.create({scope});
    const first='hello 🌍 '+('\n"\\'.repeat(1200));
    // Multiple real provider deltas below the NOTIFY payload limit.
    for(const text of snapshotParts(first))stream.onDelta({content:text,outputIndex:0,contentIndex:0});
    const [x,y,foreign]=await Promise.all([connect(a.url),connect(b.url),connect(b.url,'other')]);
    clients.push(x,y,foreign);
    await wait(()=>complete(snapshot(x,stream.responseId))&&complete(snapshot(y,stream.responseId)));
    for(const c of [x,y]){
      const parts=snapshot(c,stream.responseId);
      assert.equal(parts.sort((a,b)=>a.index-b.index).map(p=>p.content).join(''),first);
      assert.ok(parts.every(p=>p.requestId===c.events.find(e=>e.type==='response.ready').requestId));
    }
    assert.ok(!foreign.events.some(e=>e.responseId===stream.responseId));
    stream.onDelta({content:' next',outputIndex:0,contentIndex:0});
    await wait(()=>[x,y].every(c=>c.events.some(e=>e.type==='response.delta'&&e.content===' next')));
    if(disconnectListener){
      await disconnectListener();
      await wait(()=>x.events.some(e=>e.type==='response.gap')&&x.events.filter(e=>e.type==='response.ready').length===2);
      const requestId=x.events.filter(e=>e.type==='response.ready').at(-1).requestId;
      await wait(()=>complete(snapshot(x,stream.responseId).filter(e=>e.requestId===requestId)));
      assert.equal(snapshot(x,stream.responseId).filter(e=>e.requestId===requestId).sort((a,b)=>a.index-b.index).map(e=>e.content).join(''),first+' next');
    }
    stream.finish({content:first+' next'});
    await wait(()=>[x,y].every(c=>c.events.some(e=>e.type==='response.provider_finished')));
    assert.ok(!foreign.events.some(e=>e.responseId===stream.responseId));
    assert.ok(![x,y,foreign].some(c=>c.events.some(e=>e.type==='response.snapshot_request')));
    // Membership revocation terminates the SSE without touching a workspace.
    storage.records.delete(path+'/agentSessions/s');
    await Promise.race([Promise.all([x.done,y.done]),new Promise((_,reject)=>setTimeout(()=>reject(Error('revocation did not close SSE')),3000))]);
    assert.ok(storage.reads.every(p=>p.startsWith(path)));
  }finally{
    for(const c of clients)c.close();
    await Promise.allSettled(clients.map(c=>c.done));
    await registry.close();await Promise.all([a.close(),b.close()]);
  }
}

