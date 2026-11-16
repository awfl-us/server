import express from 'express';
import { randomUUID } from 'node:crypto';
import { getDocumentStorage } from '../storage/service.js';
import { projectScopedCollectionPath } from './utils.js';

const VALID_STATUSES = ['Queued', 'In Progress', 'Done', 'Stuck'];
const validateStatus = status => VALID_STATUSES.includes(status);
const guardStatus = (status, res) => {
  if (status && !validateStatus(status)) {
    res.status(400).json({error:`Invalid status. Must be one of ${VALID_STATUSES.join(', ')}`});
    return false;
  }
  return true;
};

export function createTasksRouter({getStorage=getDocumentStorage}={}) {
  const router=express.Router();
  router.use(express.json());
  const collection=req=>projectScopedCollectionPath(req.userId,req.projectId,'tasks');
  const path=(req,id)=>collection(req)+'/'+id;
  const get=()=>getStorage();
  router.use((req,res,next)=>{
    if(!req?.userId)return res.status(401).json({error:'Unauthorized: missing req.userId'});
    next();
  });

  router.post('/',async(req,res)=>{
    try{
      const {sessionId,title,description,status}=req.body||{};
      if(!sessionId)return res.status(400).json({error:'sessionId is required'});
      if(!guardStatus(status,res))return;
      const now=Date.now(),id=randomUUID().replaceAll('-','');
      const task={id,sessionId,title:title||null,description:description||null,
        status:status||'Queued',created:now,updated:now};
      await (await get()).create(path(req,id),task);
      return res.status(201).json({task});
    }catch(error){console.error('[tasks] create failed',error);return res.status(500).json({error:'Failed to create task'});}
  });

  router.get('/meta/statuses',(_req,res)=>res.status(200).json({statuses:VALID_STATUSES}));
  router.get('/by-session/:sessionId',async(req,res)=>{
    try{
      const {sessionId}=req.params;
      const {status,limit=50,order='desc'}=req.query||{};
      if(!guardStatus(status,res))return;
      const where=[{field:'sessionId',op:'==',value:sessionId}];
      if(status)where.push({field:'status',op:'==',value:status});
      const tasks=await (await get()).query({collection:collection(req),where,
        orderBy:{field:'created',direction:order==='asc'?'asc':'desc'},
        limit:Math.min(Math.max(Number(limit)||50,1),200)});
      return res.status(200).json({tasks:tasks.map(item=>item.data)});
    }catch(error){console.error('[tasks] list by session failed',error);return res.status(500).json({error:'Failed to list tasks by session'});}
  });
  router.get('/',async(req,res)=>{
    try{
      const {sessionId,status,limit=50,order='desc'}=req.query||{};
      if(!guardStatus(status,res))return;
      const where=[];
      if(sessionId)where.push({field:'sessionId',op:'==',value:sessionId});
      if(status)where.push({field:'status',op:'==',value:status});
      const tasks=await (await get()).query({collection:collection(req),where,
        orderBy:{field:'created',direction:order==='asc'?'asc':'desc'},
        limit:Math.min(Math.max(Number(limit)||50,1),200)});
      return res.status(200).json({tasks:tasks.map(item=>item.data)});
    }catch(error){console.error('[tasks] list failed',error);return res.status(500).json({error:'Failed to list tasks'});}
  });
  router.get('/:id',async(req,res)=>{
    try{
      const doc=await (await get()).get(path(req,req.params.id));
      if(!doc)return res.status(404).json({error:'Task not found'});
      return res.status(200).json({task:doc.data});
    }catch(error){console.error('[tasks] get failed',error);return res.status(500).json({error:'Failed to get task'});}
  });
  const update=async(req,res,statusOnly=false)=>{
    try{
      const input=req.body||{};
      if(statusOnly&&!input.status)return res.status(400).json({error:'status is required'});
      if(!guardStatus(input.status,res))return;
      const store=await get(),id=path(req,req.params.id);
      let task=null;
      await store.transaction(async tx=>{
        const existing=await tx.get(id);
        if(!existing)return;
        const updates={updated:Date.now()};
        for(const name of statusOnly?['status']:['sessionId','title','description','status']){
          if(input[name]!==undefined&&input[name]!==null)updates[name]=input[name];
        }
        task={...existing.data,...updates};
        await tx.put(id,task);
      });
      if(!task)return res.status(404).json({error:'Task not found'});
      return res.status(200).json({task});
    }catch(error){console.error('[tasks] update failed',error);
      return res.status(500).json({error:statusOnly?'Failed to update status':'Failed to update task'});}
  };
  router.patch('/:id',(req,res)=>update(req,res));
  router.post('/:id/status',(req,res)=>update(req,res,true));
  router.delete('/:id',async(req,res)=>{
    try{
      const store=await get(),id=path(req,req.params.id);
      const doc=await store.get(id);
      if(!doc)return res.status(404).json({error:'Task not found'});
      await store.delete(id);
      return res.status(200).json({ok:true});
    }catch(error){console.error('[tasks] delete failed',error);return res.status(500).json({error:'Failed to delete task'});}
  });
  return router;
}
