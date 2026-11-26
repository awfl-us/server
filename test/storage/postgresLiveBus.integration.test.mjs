import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {PostgresLiveBus} from '../../workflows/events/postgresLiveBus.js';
const enabled=Boolean(process.env.PGTEST_URL||process.env.AWFL_LIVE_PG_TEST==='1');
const wait=async(fn,ms=5000)=>{const until=Date.now()+ms;while(!fn()&&Date.now()<until)await new Promise(r=>setTimeout(r,15));assert.ok(fn(),'condition timed out');};

test('real PostgreSQL transient fanout, tenant filtering, reconnect and idle connection cleanup',{skip:!enabled,timeout:30000},async()=>{
  const pools=[];
  const pool=()=>{const p=new pg.Pool({...(process.env.PGTEST_URL?{connectionString:process.env.PGTEST_URL}:{}),max:1,connectionTimeoutMillis:5000});pools.push(p);return p;};
  const key=randomBytes(32),channel='awfl_live_test_'+randomUUID().replaceAll('-','');
  const make=()=>new PostgresLiveBus({publisherPool:pool(),listenerPool:pool(),key,channel,reconnectMs:50});
  const a=make(),b=make(),c=make(),observer=pool();
  const scope={userId:'u',projectId:'p',sessionId:'s'},foreign={...scope,userId:'foreign'};
  const e=(n,s=scope)=>({scope:s,responseId:'r',attemptId:'a',sequence:n,type:'response.delta',data:{content:'🌍'+n}});
  const received=[],received2=[],other=[],statuses=[];
  try{
    const stop=await b.subscribe(scope,x=>received.push(x.sequence),{onStatus:s=>statuses.push(s)});
    const stop2=await c.subscribe(scope,x=>received2.push(x.sequence));
    const stop3=await c.subscribe(foreign,x=>other.push(x.sequence));
    await b.subscribe(scope,()=>{throw Error('bad subscriber');});
    // Only pg_notify is used; no tables are required or initialized by the bus.
    await Promise.all(Array.from({length:20},(_,i)=>a.publish(e(i))));
    await a.publish(e(100,foreign));
    await wait(()=>received.length===20&&received2.length===20&&other.length===1);
    assert.deepEqual(received,Array.from({length:20},(_,i)=>i));assert.deepEqual(received2,received);assert.deepEqual(other,[100]);
    const pid=b.client.processID;
    await observer.query('SELECT pg_terminate_backend($1)',[pid]);
    await wait(()=>statuses.includes('gap')&&statuses.filter(s=>s==='ready').length===2);
    await a.publish(e(21));await wait(()=>received.at(-1)===21&&received2.at(-1)===21);
    stop();stop2();stop3();assert.equal(b.client,null);assert.equal(c.client,null);
    assert.equal(a.pending,0);
  }finally{await Promise.all([a.close(),b.close(),c.close()]);await Promise.all(pools.map(p=>p.end()));}
});
