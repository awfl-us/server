import express from 'express';
import { randomUUID } from 'node:crypto';
import { getDocumentStorage } from '../../storage/service.js';
import { userScopedCollectionPath, loadFileDefinedAgents } from './common.js';

const router=express.Router();
const path=(userId,id)=>userScopedCollectionPath(userId,`agents/${id}`);
const coll=userId=>userScopedCollectionPath(userId,'agents');
function dedupeById(preferred=[],fallbacks=[]) {
  const map=new Map();
  for(const item of [...preferred,...fallbacks])if(item?.id&&!map.has(item.id))map.set(item.id,item);
  return [...map.values()];
}
router.post('/',async(req,res)=>{
  try{
    const {name,description,workflowName,tools,inputSchema}=req.body||{};
    if(!name||typeof name!=='string')return res.status(400).json({error:'name is required'});
    const id=randomUUID().replaceAll('-',''),now=Date.now();
    const data={id,name:name.trim(),description:typeof description==='string'?description:null,
      workflowName:typeof workflowName==='string'?workflowName.trim():null,created:now,updated:now};
    if(Array.isArray(tools)&&tools.length)data.tools=tools;
    if(inputSchema&&typeof inputSchema==='object')data.inputSchema=inputSchema;
    await (await getDocumentStorage()).create(path(req.userId,id),data);
    return res.status(201).json({agent:data});
  }catch(error){console.error('[agents] create failed',error);return res.status(500).json({error:'Failed to create agent'});}
});
router.get('/',async(req,res)=>{
  try{
    const {limit=50,order='desc'}=req.query||{};
    const docs=await (await getDocumentStorage()).query({collection:coll(req.userId),
      orderBy:{field:'created',direction:order==='asc'?'asc':'desc'},
      limit:Math.min(Math.max(Number(limit)||50,1),200)});
    const agents=dedupeById(docs.map(d=>d.data),await loadFileDefinedAgents());
    return res.status(200).json({agents});
  }catch(error){console.error('[agents] list failed',error);return res.status(500).json({error:'Failed to list agents'});}
});
router.get('/:id',async(req,res)=>{
  try{
    const doc=await (await getDocumentStorage()).get(path(req.userId,req.params.id));
    if(doc)return res.status(200).json({agent:doc.data});
    const found=(await loadFileDefinedAgents()).find(a=>a.id===req.params.id);
    if(found)return res.status(200).json({agent:found});
    return res.status(404).json({error:'Agent not found'});
  }catch(error){console.error('[agents] get failed',error);return res.status(500).json({error:'Failed to get agent'});}
});
router.patch('/:id',async(req,res)=>{
  try{
    const {name,description,workflowName,inputSchema}=req.body||{};
    const id=path(req.userId,req.params.id),store=await getDocumentStorage();
    let result;
    await store.transaction(async tx=>{
      const doc=await tx.get(id);
      if(!doc)return;
      const updates={updated:Date.now()};
      if(name!=null)updates.name=String(name).trim();
      if(description!=null)updates.description=typeof description==='string'?description:null;
      if(workflowName!=null)updates.workflowName=typeof workflowName==='string'?workflowName.trim():null;
      if(inputSchema!=null)updates.inputSchema=typeof inputSchema==='object'?inputSchema:null;
      result={...doc.data,...updates};
      await tx.put(id,result);
    });
    if(!result)return res.status(404).json({error:'Agent not found'});
    return res.status(200).json({agent:result});
  }catch(error){console.error('[agents] update failed',error);return res.status(500).json({error:'Failed to update agent'});}
});
router.delete('/:id',async(req,res)=>{
  try{
    const id=path(req.userId,req.params.id),store=await getDocumentStorage();
    if(!await store.get(id))return res.status(404).json({error:'Agent not found'});
    await store.delete(id);
    return res.status(200).json({ok:true});
  }catch(error){console.error('[agents] delete failed',error);return res.status(500).json({error:'Failed to delete agent'});}
});
export default router;
