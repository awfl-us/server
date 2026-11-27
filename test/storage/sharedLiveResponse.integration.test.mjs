import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {PostgresStorage} from '../../storage/postgres/storage.js';
import {PostgresLiveBus} from '../../workflows/events/postgresLiveBus.js';
import {runLiveScenario,wait} from '../../workflows/events/liveResponseTestFixture.js';

const enabled=Boolean(process.env.PGTEST_URL||process.env.AWFL_LIVE_PG_TEST==='1');
test('shared listener preserves document watchers and real live SSE recovery within existing pool caps',
  {skip:!enabled,timeout:45000},async()=>{
    const pools=[],stores=[],buses=[];
    const pool=()=>{const p=new pg.Pool({...(process.env.PGTEST_URL?{connectionString:process.env.PGTEST_URL}:{}),max:3,connectionTimeoutMillis:5000});pools.push(p);return p;};
    const key=randomBytes(32);
    const make=()=>{
      const storage=new PostgresStorage({pool:pool(),liveNotifications:true,pollIntervalMs:200});
      const bus=new PostgresLiveBus({key,sharedTransport:{
        publish:p=>storage.publishLiveNotification(p),
        subscribe:(listener,status)=>storage.subscribeLiveNotifications(listener,status)
      }});
      stores.push(storage);buses.push(bus);
      return {storage,bus};
    };
    const producer=make(),api1=make(),api2=make(),observer=pool();
    const path='liveBusBenchmark/'+randomUUID();
    const docEvents=[];
    let stopDoc,created=false;
    try{
      await producer.storage.create(path,{sequence:0});created=true;
      stopDoc=await api1.storage.subscribe(path,e=>{if(e.value?.data)docEvents.push(e.value.data.sequence);});
      const initialPid=api1.storage.listenClient.processID;
      await runLiveScenario({producerBus:producer.bus,apiBus1:api1.bus,apiBus2:api2.bus,
        disconnectListener:async()=>{
          assert.equal(api1.storage.listenClient.processID,initialPid,'live and durable watchers share one listener');
          await producer.storage.put(path,{sequence:1});
          await wait(()=>docEvents.includes(1));
          await observer.query('SELECT pg_terminate_backend($1)',[initialPid]);
          await wait(()=>api1.storage.listenClient&&api1.storage.listenClient.processID!==initialPid,5000);
          await producer.storage.put(path,{sequence:2});
          await wait(()=>docEvents.includes(2));
        }});
      assert.ok(docEvents.includes(0)&&docEvents.includes(1)&&docEvents.includes(2));
      assert.ok(api1.storage.listenClient,'document watcher remains after SSE closes');
      assert.ok(pools.slice(0,3).every(p=>p.totalCount<=3));
      assert.equal(api1.storage.liveWatchers.size,0);
      await stopDoc();stopDoc=null;
      await wait(()=>stores.every(s=>!s.listenClient));
    }finally{
      if(stopDoc)await stopDoc();
      await Promise.allSettled(buses.map(b=>b.close()));
      if(created)await producer.storage.delete(path);
      await Promise.allSettled(stores.map(s=>s.close()));
      await Promise.allSettled(pools.map(p=>p.end()));
    }
  });
