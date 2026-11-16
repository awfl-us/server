import {randomUUID} from 'node:crypto';
import {getDocumentStorage} from '../../storage/service.js';
import {projectScopedCollectionPath} from '../userAuth.js';
import {projectPath} from '../projects/util.js';

const workspacePath=(userId,projectId)=>projectScopedCollectionPath(userId,projectId,'workspaces');

export async function resolveWorkspace({userId,projectId,sessionId,ttlMs}) {
  if(!userId||!projectId)throw new Error('resolveWorkspace: userId/projectId required');
  const ttl=Number(ttlMs)>0?Math.floor(Number(ttlMs)):5*60*1000;
  const cutoff=Date.now()-ttl;
  const store=await getDocumentStorage();
  const collection=workspacePath(userId,projectId),pid=String(projectId).trim();
  const query=async sid=>{
    const where=[{field:'projectId',op:'==',value:pid},
      {field:'live_at',op:'>=',value:cutoff},
      {field:'sessionId',op:'==',value:sid}];
    const result=await store.query({collection,where,
      orderBy:{field:'live_at',direction:'desc'},limit:1});
    return result[0]?.data??null;
  };
  const sid=typeof sessionId==='string'&&sessionId.trim()?sessionId.trim():null;
  return sid?await query(sid)||await query(null):query(null);
}

export async function registerWorkspace({userId,projectId,sessionId}) {
  if(!userId||!projectId)throw new Error('registerWorkspace: userId/projectId required');
  const store=await getDocumentStorage();
  if(!await store.get(projectPath(userId,String(projectId).trim())))throw new Error('Project not found');
  const id=randomUUID().replaceAll('-',''),now=Date.now();
  const workspace={id,projectId:String(projectId).trim(),
    sessionId:typeof sessionId==='string'&&sessionId.trim()?sessionId.trim():null,
    live_at:now,created:now,updated:now};
  await store.create(`${workspacePath(userId,projectId)}/${id}`,workspace);
  return {id,workspace};
}

export async function ensureWorkspaceId({userId,projectId,sessionId,ttlMs}) {
  const previous=await resolveWorkspace({userId,projectId,sessionId,ttlMs});
  if(previous?.id)return previous.id;
  return (await registerWorkspace({userId,projectId,sessionId})).id;
}
