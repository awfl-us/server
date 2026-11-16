// Compare independent document writes with/without the global cursor trigger.
// Run against one isolated DB before and after migration 001, same pool/workload.
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { PostgresStorage } from '../../storage/postgres/storage.js';
import { patch } from '../../storage/document/contract.js';

const url=process.env.PGTEST_URL;
if (!url) throw new Error('PGTEST_URL required: do not run against production');
const concurrency=Number(process.env.PG_BENCH_CONCURRENCY || 16);
const perWorker=Number(process.env.PG_BENCH_PER_WORKER || 24);
if (!Number.isInteger(concurrency)||concurrency<1||concurrency>24||
  !Number.isInteger(perWorker)||perWorker<1||perWorker>1000) throw new Error('invalid benchmark parameters');
const pool=new pg.Pool({connectionString:url,max:Math.min(24,concurrency+1),connectionTimeoutMillis:15000});
const storage=new PostgresStorage({pool,ownPool:true});
const collection='tests/'+randomUUID().replaceAll('-','')+'/cases';
const docs=Array.from({length:concurrency},(_,i)=>collection+'/worker'+i);
const created=new Set();
const pct=(sorted,p)=>sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)];
async function bench(name,fn){
  const samples=[],errors=[];
  const start=performance.now();
  await Promise.all(Array.from({length:concurrency},(_,i)=>(async()=>{
    for(let j=0;j<perWorker;j++){
      const at=performance.now();
      try{await fn(i,j);samples.push(performance.now()-at);}
      catch(e){errors.push({code:e.code,message:e.message.slice(0,120)});}
    }
  })()));
  samples.sort((a,b)=>a-b);
  const end=performance.now()-start;
  const fmt=x=>Number(x.toFixed(2));
  const result={success:samples.length,errors:errors.length,concurrency,perWorker,
    p50:samples.length?fmt(pct(samples,.5)):null,
    p95:samples.length?fmt(pct(samples,.95)):null,
    p99:samples.length?fmt(pct(samples,.99)):null,
    throughputOpsSec:fmt(samples.length*1000/end),elapsedMs:fmt(end)};
  console.log(name,JSON.stringify(result),errors.length?JSON.stringify(errors.slice(0,3)):'');
  return result;
}
try{
  await Promise.all(docs.map(async path=>{
    await storage.create(path,{count:0,phase:'warm'});created.add(path);
  }));
  await Promise.all(docs.map(path=>storage.get(path)));
  await Promise.all(docs.map(path=>storage.put(path,{count:0,phase:'warm'})));
  const results={};
  results.put=await bench('put-distinct-docs',(i,j)=>
    storage.put(docs[i],{count:j,phase:'put'}));
  results.update=await bench('serializable-update-distinct-docs',i=>
    storage.update(docs[i],{count:patch.increment(1)}));
  results.create=await bench('create-distinct-docs',async(i,j)=>{
    const path=collection+'/created'+i+'_'+j;
    await storage.create(path,{i,j});created.add(path);
  });
  const result={at:new Date().toISOString(),label:process.env.PG_BENCH_LABEL||'unlabeled',
    concurrency,perWorker,results};
  if(process.env.PG_BENCH_OUTPUT) await writeFile(process.env.PG_BENCH_OUTPUT,JSON.stringify(result,null,2)+'\n');
  console.log('RESULT',JSON.stringify(result));
  if(Object.values(results).some(x=>x.errors))process.exitCode=1;
}finally{
  await Promise.allSettled([...created].map(p=>storage.delete(p)));
  await storage.close();
}
