import express from 'express';
import {randomUUID} from 'node:crypto';
import {authorizeResponseScope,validResponseScope} from './liveResponseScope.js';

const liveTypes=new Set(['response.started','response.delta','response.provider_finished','response.failed']);

// Public API mount only, behind clientAuth and projectIdMiddleware.
// Authentication is renewed by reconnect; membership is checked periodically.
export function createLiveResponseRouter({getBus,getStorage,maxClients=128,lifetimeMs=300000,
  recheckMs=30000,heartbeatMs=15000}){
  const router=express.Router();let clients=0;
  router.get('/stream',async(req,res)=>{
    if(!req.userId)return res.status(401).json({error:'Unauthorized'});
    const scope={userId:req.userId,projectId:req.projectId,sessionId:req.query.sessionId};
    if(!validResponseScope(scope))return res.status(400).json({error:'Invalid response scope'});
    let storage,bus;
    try{
      storage=await getStorage();
      if(!await authorizeResponseScope(scope,storage))return res.status(404).json({error:'Session not found'});
      bus=await getBus(scope);
    }catch{return res.status(503).json({error:'Live responses unavailable'});}
    if(!bus)return res.status(503).json({error:'Live responses disabled'});
    if(res.destroyed)return;
    if(clients>=maxClients)return res.status(503).json({error:'Live response capacity reached'});
    clients++;
    let closed=false,stop,heartbeat,lifetime,recheck,requestId,checking=false;
    const close=()=>{
      if(closed)return;closed=true;clients--;
      clearInterval(heartbeat);clearInterval(recheck);clearTimeout(lifetime);
      stop?.();
      if(!res.destroyed&&!res.writableEnded)res.end();
    };
    res.once('close',close);res.once('error',close);
    res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform',
      'X-Accel-Buffering':'no'});
    function send(type,data){
      if(closed)return false;
      try {
        if(!res.write('event: '+type+'\ndata: '+JSON.stringify(data)+'\n\n')){
          close();return false;
        }
        return true;
      }catch{close();return false;}
    }
    function recover(){
      if(closed)return;
      requestId=randomUUID();
      if(!send('response.ready',{requestId}))return;
      void bus.publish({scope,responseId:requestId,attemptId:requestId,sequence:0,
        type:'response.snapshot_request',data:{}}).catch(()=>{
        send('response.gap',{reason:'snapshot_unavailable'});
      });
    }
    try{
      stop=await bus.subscribe(scope,e=>{
        if(liveTypes.has(e.type)||e.type==='response.snapshot'&&e.data.requestId===requestId){
          send(e.type,{...e.data,responseId:e.responseId,attemptId:e.attemptId,sequence:e.sequence});
        }
      },{onStatus:status=>{
        if(status==='ready')recover();
        else if(status==='gap'){requestId=null;send('response.gap',{reason:'listener_disconnected'});}
      }});
      if(closed){stop();return;}
      heartbeat=setInterval(()=>{
        try{if(!res.write(': keep-alive\n\n'))close();}catch{close();}
      },heartbeatMs);
      lifetime=setTimeout(close,lifetimeMs);
      recheck=setInterval(async()=>{
        if(checking||closed)return;checking=true;
        try{if(!await authorizeResponseScope(scope,storage))close();}
        catch{close();}finally{checking=false;}
      },recheckMs);
    }catch{
      if(!res.headersSent&&!closed)res.status(503).json({error:'Live response subscription unavailable'});
      close();
    }
  });
  return router;
}
