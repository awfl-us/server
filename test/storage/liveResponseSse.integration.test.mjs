import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {PostgresLiveBus} from '../../workflows/events/postgresLiveBus.js';
import {runLiveScenario,wait} from '../../workflows/events/liveResponseTestFixture.js';

const enabled=Boolean(process.env.PGTEST_URL||process.env.AWFL_LIVE_PG_TEST==='1');
test('real PostgreSQL Jobs-to-two-API SSE snapshot, continuous delta and listener recovery',
  {skip:!enabled,timeout:30000},async()=>{
    const pools=[];
    const pool=()=>{const p=new pg.Pool({...(process.env.PGTEST_URL?{connectionString:process.env.PGTEST_URL}:{}),max:1,connectionTimeoutMillis:5000});pools.push(p);return p;};
    const channel='awfl_sse_test_'+randomUUID().replaceAll('-',''),key=randomBytes(32);
    const make=()=>new PostgresLiveBus({publisherPool:pool(),listenerPool:pool(),channel,key,reconnectMs:50});
    const producer=make(),api1=make(),api2=make(),observer=pool();
    try{
      await runLiveScenario({producerBus:producer,apiBus1:api1,apiBus2:api2,
        disconnectListener:async()=>{
          assert.ok(api1.client);
          await observer.query('SELECT pg_terminate_backend($1)',[api1.client.processID]);
        }});
      await wait(()=>[producer,api1,api2].every(b=>!b.client));
    }finally{
      await Promise.all([producer.close(),api1.close(),api2.close()]);
      await Promise.all(pools.map(p=>p.end()));
    }
  });
