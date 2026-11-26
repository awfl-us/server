import {scryptSync} from 'node:crypto';
import {PostgresLiveBus} from './postgresLiveBus.js';
import {ResponseSnapshots} from './responseSnapshots.js';
import {authorizeResponseScope} from './liveResponseScope.js';
import {getDocumentStorage} from '../../storage/service.js';
import {selectedStorageBackend} from '../../storage/factory.js';
import {requireEnvKey} from '../crypto.js';

let components;
// Explicit project allowlist during rollout. A global rollout must separately
// choose '*' after the connection budget is verified. Missing config fails closed.
export function liveResponseScopeEnabled(scope,env=process.env){
  if(env.AWFL_LIVE_RESPONSES_ENABLED!=='1'||!scope?.projectId)return false;
  const projects=String(env.AWFL_LIVE_RESPONSES_PROJECTS||'').split(',').map(x=>x.trim()).filter(Boolean);
  return projects.includes(scope.projectId)||projects.includes('*');
}
// Off by default: connection budget and production validation are release gates.
export async function getLiveResponseComponents(){
  if(process.env.AWFL_LIVE_RESPONSES_ENABLED!=='1')return null;
  components ||= build().catch(e=>{components=null;throw e;});
  return components;
}
async function build(){
  if(selectedStorageBackend(process.env)!=='postgres')throw Error('Live responses require PostgreSQL');
  const {createPostgresConnectionOptions}=await import('../../storage/nativeMemory.js');
  const {default:pg}=await import('pg');
  const key=scryptSync(requireEnvKey(),'awfl-live-events-v1',32);
  const {options,connector}=await createPostgresConnectionOptions(process.env);
  const make=role=>new pg.Pool({...options,max:1,connectionTimeoutMillis:5000,
    idleTimeoutMillis:10000,statement_timeout:5000,query_timeout:6000,application_name:'awfl_live_'+role});
  const publisherPool=make('publish'),listenerPool=make('listen');
  // Idle connection errors must not crash a service.
  for(const p of [publisherPool,listenerPool])p.on('error',()=>console.warn('[live] idle pool connection lost'));
  try{
    const bus=new PostgresLiveBus({publisherPool,listenerPool,key});
    const snapshots=new ResponseSnapshots({bus});
    return {bus,snapshots,close:async()=>{
      await snapshots.close();await bus.close();
      await Promise.allSettled([publisherPool.end(),listenerPool.end()]);connector?.close();
    }};
  }catch(e){await Promise.allSettled([publisherPool.end(),listenerPool.end()]);connector?.close();throw e;}
  finally{key.fill(0);}
}
export async function getLiveResponseBus(scope){
  if(!liveResponseScopeEnabled(scope))return null;
  return (await getLiveResponseComponents())?.bus||null;
}
export async function createConfiguredResponseStream({scope}){
  if(!liveResponseScopeEnabled(scope))return null;
  if(!await authorizeResponseScope(scope,await getDocumentStorage()))return null;
  const live=await getLiveResponseComponents();
  return live?.snapshots.create({scope})||null;
}
