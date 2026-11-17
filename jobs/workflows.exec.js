// Workflow execution registration/status HTTP endpoints on generic document Storage.
import express from 'express';
import { getUserIdFromReq, projectScopedCollectionPath } from './userAuth.js';
import { getDocumentStorage } from '../storage/service.js';

const router = express.Router();
const COLLECTIONS = {
  links: 'workflowExecLinks', regs: 'workflowExecsBySession', statuses: 'workflowExecStatus',
};
const owner = async req => String(req?.body?.userId || await getUserIdFromReq(req) || '');
const collection = (userId, req, key) => projectScopedCollectionPath(userId, req.projectId, COLLECTIONS[key]);
const document = (path, id) => path + '/' + String(id);
const isDuplicate = err => err?.code === 'ALREADY_EXISTS' || err?.code === 6 ||
  err?.code === 'already-exists' || /already exists/i.test(String(err?.message));
const sec = value => typeof value === 'number' ? value : Number(value?.seconds ?? value?._seconds ?? 0);

router.post('/links/register', async (req,res) => {
  try {
    const userId = await owner(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing or invalid user token' });
    const { callingExecId, triggeredExecId, sessionId, created } = req.body || {};
    if (!callingExecId || !triggeredExecId || !sessionId) return res.status(400).json({ error: 'callingExecId, triggeredExecId, and sessionId are required' });
    const store = await getDocumentStorage();
    const id = `${String(callingExecId)}:${String(triggeredExecId)}`;
    const path = document(collection(userId,req,'links'),id);
    const payload = { callingExec:String(callingExecId),triggeredExec:String(triggeredExecId),
      sessionId:String(sessionId),created:typeof created==='number'?created:Math.floor(Date.now()/1000) };
    try {
      await store.create(path,payload);
      return res.status(200).json({id,data:payload,status:'created'});
    } catch(error) {
      if(!isDuplicate(error))throw error;
      await store.put(path,payload,{merge:true});
      return res.status(200).json({id,data:payload,status:'updated'});
    }
  } catch(error) {
    console.error('Error registering exec link:',error);
    return res.status(500).json({error:'Failed to register exec link',details:error?.message||String(error)});
  }
});

router.get('/links/by-calling/:callingExecId',async(req,res)=>{
  try {
    const userId = await owner(req);
    if(!userId)return res.status(401).json({error:'Unauthorized'});
    const store = await getDocumentStorage();
    const results = await store.query({ collection:collection(userId,req,'links'),
      where:[{field:'callingExec',op:'==',value:String(req.params.callingExecId)}],limit:1000 });
    return res.status(200).json(results.map(d=>({id:d.id,data:d.data})));
  } catch(error){console.error('Error listing links by caller:',error);
    return res.status(500).json({error:'Failed to list links by caller',details:error?.message||String(error)});}
});

router.get('/links/by-triggered/:triggeredExecId',async(req,res)=>{
  try {
    const userId = await owner(req);
    if(!userId)return res.status(401).json({error:'Unauthorized'});
    const store = await getDocumentStorage();
    const results = await store.query({ collection:collection(userId,req,'links'),
      where:[{field:'triggeredExec',op:'==',value:String(req.params.triggeredExecId)}],limit:1000 });
    if(!results.length)return res.status(404).json({error:'Not found'});
    const doc = results.sort((a,b)=>(b.data.created||0)-(a.data.created||0))[0];
    return res.status(200).json({id:doc.id,data:doc.data});
  } catch(error){console.error('Error get link by triggered:',error);
    return res.status(500).json({error:'Failed to get link by triggered',details:error?.message||String(error)});}
});

router.post('/status/update',async(req,res)=>{
  try {
    const userId = await owner(req);
    if(!userId)return res.status(401).json({error:'Unauthorized: missing or invalid user token'});
    const {execId,status,result,error,ended,updated,workflow}=req.body||{};
    if(!execId||typeof execId!=='string')return res.status(400).json({error:'Missing required field: execId'});
    if(status==null&&result==null&&error==null&&ended==null&&updated==null&&workflow==null)
      return res.status(400).json({error:'Nothing to update: provide one of status, result, error, ended, updated, workflow'});
    const store=await getDocumentStorage();
    const path=document(collection(userId,req,'statuses'),execId);
    const now=Math.floor(Date.now()/1000);
    let existed=false, payload;
    await store.transaction(async tx=>{
      const existing=await tx.get(path);
      existed=!!existing;
      payload={...(status!=null?{status:String(status)}:{}),
        ...(result!==undefined?{result}:{}),...(error!==undefined?{error}:{}),
        ...(ended!==undefined?{ended:Boolean(ended)}:{}),
        ...(workflow!=null?{workflow:String(workflow)}:{}),
        updated:typeof updated==='number'?updated:now,
        created:existing?.data?.created||now};
      await tx.put(path,payload,{merge:true});
    });
    // Legacy best-effort registration status mirror.
    try {
      const regs=await store.query({collection:collection(userId,req,'regs'),
        where:[{field:'execId',op:'==',value:execId}],limit:1});
      if(regs.length)await store.put(regs[0].path,{
        ...(status!=null?{status:String(status)}:{}),
        ...(ended!==undefined?{ended:Boolean(ended)}:{}),
        updated:typeof updated==='number'?updated:now,
      },{merge:true});
    }catch(mirrorErr){console.warn('Warning: failed to mirror status onto registration record:',mirrorErr?.message||mirrorErr);}
    return res.status(200).json({id:execId,data:payload,status:existed?'updated':'created'});
  }catch(err){console.error('Error updating exec status:',err);
    return res.status(500).json({error:'Failed to update exec status',details:err?.message||String(err)});}
});

router.post('/status',async(req,res)=>{
  try {
    const userId=await owner(req);
    if(!userId)return res.status(401).json({error:'Unauthorized'});
    const {sessionId}=req.body||{};
    if(!sessionId||typeof sessionId!=='string')return res.status(400).json({error:'Missing required field: sessionId'});
    const inputLimit=Number(req.body?.limit??req.query?.limit);
    const limit=Number.isFinite(inputLimit)&&inputLimit>0?Math.min(50,Math.floor(inputLimit)):5;
    const store=await getDocumentStorage();
    const regs=await store.query({collection:collection(userId,req,'regs'),
      where:[{field:'sessionId',op:'==',value:sessionId}],
      orderBy:{field:'created',direction:'desc'},limit});
    if(!regs.length)return res.status(404).json({error:'No executions found for session'});
    const statusesCollection=collection(userId,req,'statuses');
    const items=regs.map(d=>({execId:String(d.data.execId||''),created:sec(d.data.created)}))
      .filter(d=>d.execId);
    const results=await Promise.all(items.map(async item=>{
      try{const record=await store.get(document(statusesCollection,item.execId));
        return record?{...item,...record.data}:{...item,status:'UNKNOWN'};
      }catch(error){return {...item,status:'UNKNOWN',error:'status-fetch-failed: '+(error?.message||String(error))};}
    }));
    return res.status(200).json({sessionId,limit,items:results});
  }catch(error){console.error('Error getting latest exec statuses (POST):',error);
    return res.status(500).json({error:'Failed to get latest exec statuses',details:error?.message||String(error)});}
});
export default router;
