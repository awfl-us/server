import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PostgresLiveBus,encodeLiveEvent,decodeLiveEvent,MAX_LIVE_NOTIFY_BYTES} from './postgresLiveBus.js';
const key=randomBytes(32),scope={userId:'u',projectId:'p',sessionId:'s'};
const event=(n=1,s=scope)=>({scope:s,responseId:'r',attemptId:'a',sequence:n,type:'response.delta',data:{content:'private 🌍'}});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('authenticated notifications preserve Unicode, reject tampering, wrong keys, channels and oversized content',()=>{
  const e=event(),wire=encodeLiveEvent(e,key);
  assert.ok(!wire.includes('private'));assert.deepEqual(decodeLiveEvent(wire,key),e);
  assert.notEqual(encodeLiveEvent(e,key),wire);
  const bytes=Buffer.from(wire,'base64');bytes[30]^=1;
  assert.throws(()=>decodeLiveEvent(bytes.toString('base64'),key));
  assert.throws(()=>decodeLiveEvent(wire,randomBytes(32)));
  assert.throws(()=>decodeLiveEvent(wire,key,'another_channel'));
  assert.throws(()=>encodeLiveEvent({...e,data:{content:'🌍'.repeat(MAX_LIVE_NOTIFY_BYTES)}},key),/size/);
  assert.throws(()=>encodeLiveEvent({...e,scope:{...scope,userId:''}},key));
});

function mock(){
  const clients=[],queries=[],pending=[];
  const publisherPool={query:(sql,args)=>{queries.push({sql,args});return new Promise((resolve,reject)=>pending.push({resolve,reject}));}};
  const listenerPool={connect:async()=>{const c=new EventEmitter();c.query=async()=>{};c.release=()=>{c.released=true;};clients.push(c);return c;}};
  return {clients,queries,pending,bus:new PostgresLiveBus({publisherPool,listenerPool,key,maxPending:2,reconnectMs:10})};
}
test('publisher FIFO bounds pending work, rejects uncertain send without retry and continues later sends',async()=>{
  const {bus,queries,pending}=mock();
  const a=bus.publish(event(1)),b=bus.publish(event(2));
  await assert.rejects(bus.publish(event(3)),/queue full/);
  await tick();assert.equal(queries.length,1);
  const failure=assert.rejects(a,/uncertain/);pending.shift().reject(Error('uncertain'));await failure;await tick();
  assert.equal(queries.length,2);assert.equal(queries[0].sql,'SELECT pg_notify($1,$2)');
  assert.deepEqual(queries.map(x=>decodeLiveEvent(x.args[1],key).sequence),[1,2]);
  pending.shift().resolve();await b;assert.equal(bus.pending,0);assert.equal(bus.peakPending,2);await bus.close();
});
test('scoped fanout isolates tenants and failed subscribers, reconnect reports gap, last close destroys socket',async()=>{
  const {bus,clients}=mock();const received=[],statuses=[];
  const stop=await bus.subscribe(scope,e=>received.push(e.sequence),{onStatus:s=>statuses.push(s)});
  const other={...scope,userId:'other'};const foreign=[];
  const stopOther=await bus.subscribe(other,e=>foreign.push(e.sequence));
  await bus.subscribe(scope,()=>{throw Error('broken subscriber');});
  await bus.subscribe(scope,()=>Promise.reject(Error('async subscriber')));
  const notify=(e,c=clients.at(-1))=>c.emit('notification',{channel:'awfl_live_v1',payload:encodeLiveEvent(e,key)});
  notify(event(1));notify(event(2));notify(event(3,other));assert.deepEqual(received,[1,2]);assert.deepEqual(foreign,[3]);
  clients[0].emit('error',Error('lost'));
  const deadline=Date.now()+1000;while(clients.length<2&&Date.now()<deadline)await new Promise(r=>setTimeout(r,15));
  assert.equal(clients.length,2);assert.deepEqual(statuses,['ready','gap','ready']);
  notify(event(4));assert.deepEqual(received,[1,2,4]);
  stop();stopOther();assert.equal(clients[1].released,true);await bus.close();
});
