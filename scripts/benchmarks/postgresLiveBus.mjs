// Short isolated database benchmark. Never target the production database.
import {fork} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import pg from 'pg';
import {PostgresLiveBus} from '../../workflows/events/postgresLiveBus.js';
import {PostgresStorage} from '../../storage/postgres/storage.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const pool=(max=1)=>new pg.Pool({max,connectionTimeoutMillis:5000,idleTimeoutMillis:5000,application_name:'awfl_live_bus_bench'});
const scopes=[0,1].map(i=>({userId:'benchmark',projectId:'benchmark',sessionId:'session'+i}));
const stats=xs=>{const a=[...xs].sort((x,y)=>x-y);const at=q=>a.length?Math.round(a[Math.min(a.length-1,Math.floor(a.length*q))]*100)/100:null;return {p50:at(.5),p95:at(.95),p99:at(.99)};};
const absolute=()=>performance.timeOrigin+performance.now();
if(process.env.PGDATABASE!=='awfl_bench')throw Error('Benchmark requires PGDATABASE=awfl_bench');
if(process.env.LIVE_BENCH_CHILD){
  const shared=process.env.LIVE_BENCH_SHARED==='1';
  const publisherPool=pool(shared?3:1),listenerPool=shared?null:pool(),mode=process.env.LIVE_BENCH_CHILD;
  const storage=shared?new PostgresStorage({pool:publisherPool,liveNotifications:true}):null;
  const bus=new PostgresLiveBus({publisherPool,listenerPool,key:Buffer.from(process.env.LIVE_BENCH_KEY,'hex'),channel:process.env.LIVE_BENCH_CHANNEL,
    ...(shared?{sharedTransport:{publish:p=>storage.publishLiveNotification(p),subscribe:(fn,status)=>storage.subscribeLiveNotifications(fn,status)}}:{})});
  const path='liveBusBenchmark/'+randomUUID();let stopDoc,docSequence=0;
  if(shared){await storage.create(path,{sequence:0});stopDoc=await storage.subscribe(path,()=>{});}
  async function localProbe(duration){const values=[];if(!shared)return values;const end=absolute()+duration;while(absolute()<end){const start=absolute();await storage.put(path,{sequence:++docSequence});await storage.get(path);values.push(absolute()-start);await sleep(40);}return values;}
  let seen=new Map(),latencies=[],duplicates=0,outOfOrder=0;
  const latest=new Map();
  const onEvent=e=>{const id=e.attemptId+':'+e.responseId+':'+e.sequence;if(seen.has(id))duplicates++;
    else{seen.set(id,e);latencies.push(absolute()-e.data.sentAt);}
    const k=e.attemptId+':'+e.responseId;if(latest.has(k)&&e.sequence<=latest.get(k))outOfOrder++;latest.set(k,e.sequence);};
  if(mode==='listen')for(const s of scopes)await bus.subscribe(s,onEvent);
  else await publisherPool.query('SELECT 1');
  process.send({ready:true});
  process.on('message',async m=>{
    if(m.cmd==='reset'){seen.clear();latest.clear();latencies=[];duplicates=0;outOfOrder=0;process.send({id:m.id});}
    if(m.cmd==='stats')process.send({id:m.id,count:seen.size,duplicates,outOfOrder,latency:stats(latencies),poolConnections:publisherPool.totalCount});
    if(m.cmd==='probe'){const values=await localProbe(m.duration);process.send({id:m.id,latency:stats(values),poolConnections:publisherPool.totalCount});}
    if(m.cmd==='publish'){
      let accepted=0,rejected=0,peak=0;const tasks=[];const scope=scopes[m.index];const start=absolute()+150;
      for(let i=0;i<m.count;i++){
        const target=start+i*1000/m.rate;
        if(target>absolute())await sleep(target-absolute());
        tasks.push(bus.publish({scope,responseId:'publisher'+m.index,attemptId:m.attempt,sequence:i,type:'response.delta',data:{content:'x'.repeat(128),sentAt:absolute()}}).then(()=>accepted++,()=>rejected++));
        peak=Math.max(peak,bus.pending);
      }
      await Promise.all(tasks);process.send({id:m.id,accepted,rejected,peak,elapsedMs:Math.round(absolute()-start)});
    }
    if(m.cmd==='close'){await bus.close();if(shared){await stopDoc();await storage.delete(path);await storage.close();}await Promise.all([publisherPool.end(),listenerPool?.end()]);process.send({id:m.id});process.disconnect();}
  });
}else{
  const observer=pool(),children=[];let serial=0;
  const documents=new PostgresStorage({pool:observer});
  const documentProbe=process.env.LIVE_BENCH_DOCUMENT_PROBE==='1';
  const probePath='liveBusBenchmark/'+randomUUID();
  let probeCreated=false,probeSequence=0;
  const shared=process.env.LIVE_BENCH_SHARED==='1';
  const key=randomBytes(32).toString('hex'),channel=shared?'awfl_live_v1':'awfl_live_bench_'+randomUUID().replaceAll('-','');
  function child(mode){const p=fork(fileURLToPath(import.meta.url),[],{env:{...process.env,LIVE_BENCH_CHILD:mode,LIVE_BENCH_KEY:key,LIVE_BENCH_CHANNEL:channel},stdio:['ignore','inherit','inherit','ipc']});children.push(p);return new Promise((resolve,reject)=>{p.once('error',reject);p.once('exit',c=>reject(Error('child exited '+c)));p.once('message',m=>m.ready?resolve(p):reject(Error('child not ready')));});}
  function ask(p,msg){return new Promise((resolve,reject)=>{const id=++serial;const timeout=setTimeout(()=>{p.off('message',handler);reject(Error('child timeout'));},25000);function handler(m){if(m.id!==id)return;clearTimeout(timeout);p.off('message',handler);resolve(m);}p.on('message',handler);p.send({...msg,id});});}
  async function probe(duration){const ms=[];const end=absolute()+duration;while(absolute()<end){const start=absolute();if(documentProbe){await documents.put(probePath,{sequence:++probeSequence});await documents.get(probePath);}else await observer.query('SELECT 1');ms.push(absolute()-start);await sleep(40);}return stats(ms);}
  try {
    const config=(await observer.query("SELECT current_database() AS database, current_setting('max_connections') AS max_connections, current_setting('server_version') AS version, pg_notification_queue_usage() AS queue")).rows[0];
    if(config.database!=='awfl_bench')throw Error('wrong database');
    if(documentProbe){await documents.create(probePath,{sequence:0});probeCreated=true;}
    console.log('BENCH_CONFIG',JSON.stringify({...config,probe:documentProbe?'document put+get':'select 1'}));
    const listeners=await Promise.all([child('listen'),child('listen')]),publishers=await Promise.all([child('publish'),child('publish')]);
    const localChildren=[...listeners,...publishers];
    const [baseline,localBaseline]=await Promise.all([probe(1500),shared?Promise.all(localChildren.map(p=>ask(p,{cmd:'probe',duration:1500}))):[]]);console.log('BENCH_BASELINE',JSON.stringify({baseline,localBaseline}));
    for(const rate of (shared?[50,100,500]:[50,100,500,1000])){
      await Promise.all(listeners.map(p=>ask(p,{cmd:'reset'})));
      const attempt=randomUUID();const n=rate;const [pub,read,local]=await Promise.all([Promise.all(publishers.map((p,index)=>ask(p,{cmd:'publish',index,count:n,rate:rate/2,attempt}))),probe(2200),shared?Promise.all(localChildren.map(p=>ask(p,{cmd:'probe',duration:2200}))):[]]);
      const accepted=pub.reduce((a,x)=>a+x.accepted,0);
      let results;for(let i=0;i<20;i++){results=await Promise.all(listeners.map(p=>ask(p,{cmd:'stats'})));if(results.every(x=>x.count===accepted))break;await sleep(50);}
      const queue=(await observer.query('SELECT pg_notification_queue_usage() AS queue')).rows[0].queue;
      const summary={rate,offered:n*2,accepted,rejected:pub.reduce((a,x)=>a+x.rejected,0),peakPending:Math.max(...pub.map(x=>x.peak)),publishElapsedMs:Math.max(...pub.map(x=>x.elapsedMs)),listeners:results,read,local,queue};
      console.log('BENCH_STAGE',JSON.stringify(summary));
      if(rate===100&&(!results.every(x=>x.count===accepted&&x.duplicates===0&&x.outOfOrder===0&&x.latency.p95<50)||accepted!==n*2))console.log('BENCH_GATE_FAILED');
      if(read.p95>Math.max(100,baseline.p95*5)||queue>0.01){console.log('BENCH_STOP_OVERLOAD');break;}
      await sleep(250);
    }
  }finally{await Promise.allSettled(children.map(p=>ask(p,{cmd:'close'})));for(const p of children)if(p.connected)p.kill();try{if(probeCreated)await documents.delete(probePath);}finally{await observer.end();}}
}
