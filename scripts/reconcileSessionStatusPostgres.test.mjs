// Regression for the production session-info `status=unknown` after a native
// ProjectManager turn. The local PostgreSQL database is mandatory: never query prod.
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {PostgresStorage} from '../storage/postgres/storage.js';
import {StorageCompatFirestore} from '../storage/legacyBridge.js';
import {latestSessionExecutions} from '../workflows/exec/statusService.js';
import {AgentSessionService} from '../agentsMcp/service.js';

const DB=process.env.PGTEST_URL;
if(DB){
  const url=new URL(DB);
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||
     url.pathname!=='/awfl_reconcile')
    throw new Error('Refusing non-isolated PostgreSQL database');
}

test('session-info returns completed foreground execution behind 125 statusless native children',
  {skip:!DB,timeout:90000},async()=>{
  const pool=new pg.Pool({connectionString:DB,max:6});
  const storage=new PostgresStorage({pool});
  const user='status-local-'+randomUUID().replaceAll('-','');
  const project='project-test';
  const session='session-test';
  const prefix=`users/${user}/projects/${project}`;
  const reg=`${prefix}/workflowExecsBySession`;
  const status=`${prefix}/workflowExecStatus`;
  const all=[];
  const add=(path,data)=>{all.push({op:'create',path,data});};
  try{
    await storage.initialize();
    add(`${prefix}`,{name:'Status pagination integration test'});
    add(`${prefix}/convo.sessions/${session}`,{title:'Completed ProjectManager'});
    add(`${reg}/foreground`,{sessionId:session,execId:'foreground',created:1000});
    add(`${status}/foreground`,{status:'Done',ended:true,workflow:'codebase-ProjectManager',updated:1001});
    // Native child workflows register before/while doing work but do not
    // write a top-level lifecycle Status. All of them are newer than foreground.
    for(let i=0;i<125;i++){
      const id='child-'+String(i).padStart(3,'0');
      // Same-second registrations also exercise stable cursor tie ordering.
      add(`${reg}/${id}`,{sessionId:session,execId:id,created:2000+Math.floor(i/3)});
    }
    add(`${reg}/older`,{sessionId:session,execId:'older',created:900});
    add(`${status}/older`,{status:'Failed',ended:true,error:'old failure',updated:901});
    // Session with registered workflows but no status must remain unknown.
    add(`${prefix}/convo.sessions/no-status`,{title:'Pending or untracked'});
    add(`${reg}/untracked`,{sessionId:'no-status',execId:'untracked',created:3000});
    await storage.batch(all);
    const db=new StorageCompatFirestore(storage);
    const args={db,userId:user,projectId:project,sessionId:session};
    const service=new AgentSessionService({db});
    const direct=await latestSessionExecutions({...args,limit:2,includeMetadata:true});
    assert.equal(direct.hasRegistrations,true);
    assert.deepEqual(direct.items.map(e=>[e.execId,e.status]),
      [['foreground','Done'],['older','Failed']]);
    const sessionInfo=await service.getSession(user,{project_id:project,session_id:session});
    assert.equal(sessionInfo.status,'Done');
    assert.equal(sessionInfo.latest_execution?.execId,'foreground');
    assert.equal(sessionInfo.latest_execution?.ended,true);
    const unknown=await service.getSession(user,{project_id:project,session_id:'no-status'});
    assert.equal(unknown.status,'unknown');
    assert.equal(unknown.latest_execution,null);
    console.log('SESSION_STATUS_POSTGRES_PASS',JSON.stringify({
      sessionStatus:sessionInfo.status,latestExec:sessionInfo.latest_execution?.execId,
      skippedChildren:125,olderStatuses:direct.items.length,unknown:unknown.status}));
  }finally{
    if(all.length){
      await storage.batch(all.map(({path})=>({op:'delete',path}))).catch(error=>{
        console.error('Local test cleanup failure',error);throw error;
      });
    }
    await storage.close();await pool.end();
  }
});
