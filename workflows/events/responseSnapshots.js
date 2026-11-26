import { createResponseStream } from '../../jobs/llm/responseStream.js';

const scopeKey=s=>JSON.stringify([s.userId,s.projectId,s.sessionId]);
const snapshotRequest=e=>e.type==='response.snapshot_request'&&e.sequence===0&&
  e.responseId===e.attemptId&&/^[0-9a-f-]{36}$/.test(e.responseId);

// Size-only fragmentation, preserving Unicode and JSON escaping bounds.
// Ordinary provider deltas are never buffered or coalesced by this registry.
export function snapshotParts(text) {
  const parts=[];let part='',bytes=0;
  for(const ch of text){
    const n=Buffer.byteLength(JSON.stringify(ch))-2;
    if(bytes+n>2600){parts.push(part);part='';bytes=0;}
    part+=ch;bytes+=n;
  }
  parts.push(part);return parts;
}

export class ResponseSnapshots {
  constructor({bus,maxResponses=64,maxTextBytes=128*1024,graceMs=30000,maxLifetimeMs=300000}){
    this.bus=bus;this.maxResponses=maxResponses;this.maxTextBytes=maxTextBytes;
    this.graceMs=graceMs;this.maxLifetimeMs=maxLifetimeMs;
    this.scopes=new Map();this.count=0;this.closed=false;this.snapshotJobs=0;
  }
  async create({scope}){
    if(this.closed||this.count>=this.maxResponses)throw Error('Response registry full');
    const key=scopeKey(scope);let group=this.scopes.get(key);
    if(!group){
      group={scope,states:new Set(),unsubscribe:null,ready:null,busy:false,requests:new Set()};
      this.scopes.set(key,group);
      group.ready=this.bus.subscribe(scope,e=>{
        if(!snapshotRequest(e)||group.requests.size>=8)return;
        group.requests.add(e.responseId);this.#schedule();
      }).then(stop=>{group.unsubscribe=stop;if(this.closed||!group.states.size)stop();});
    }
    const state={text:'',bytes:0,sequence:0,status:'response.started',recoverable:true,timer:null};
    group.states.add(state);this.count++;
    const remove=()=>{
      if(!group.states.delete(state))return;
      clearTimeout(state.timer);this.count--;
      if(!group.states.size){if(this.scopes.get(key)===group)this.scopes.delete(key);group.unsubscribe?.();}
    };
    try{
      await group.ready;
      if(this.closed)throw Error('Response registry closed');
      const stream=createResponseStream({bus:this.bus,scope,observe:event=>{
        if(!group.states.has(state))return;
        state.responseId=event.responseId;state.attemptId=event.attemptId;
        state.sequence=event.sequence;state.status=event.type;
        if(event.type==='response.delta'&&state.recoverable){
          state.bytes+=Buffer.byteLength(event.data.content);
          if(state.bytes>this.maxTextBytes){state.text='';state.recoverable=false;}
          else state.text+=event.data.content;
        }
        if(event.type==='response.provider_finished'||event.type==='response.failed'){
          state.terminal=event.data;clearTimeout(state.timer);
          state.timer=setTimeout(remove,this.graceMs);state.timer.unref?.();
        }
      }});
      state.timer=setTimeout(remove,this.maxLifetimeMs);state.timer.unref?.();
      return stream;
    }catch(e){remove();throw e;}
  }
  #schedule(){
    if(this.closed)return;
    for(const group of this.scopes.values()){
      if(this.snapshotJobs>=4)break;
      if(group.busy||!group.requests.size)continue;
      const requestId=group.requests.values().next().value;
      group.requests.delete(requestId);group.busy=true;this.snapshotJobs++;
      void this.#reply(group,requestId).catch(()=>{}).finally(()=>{group.busy=false;this.snapshotJobs--;this.#schedule();});
    }
  }
  async #reply(group,requestId){
    // Copy synchronously so text and sequence have the same watermark even
    // while provider generation proceeds. Only one reply per scope in flight.
    const snapshots=[...group.states].filter(s=>s.responseId&&s.recoverable).map(s=>({
      responseId:s.responseId,attemptId:s.attemptId,sequence:s.sequence,
      status:s.status,terminal:s.terminal,parts:snapshotParts(s.text)
    }));
    for(const s of snapshots){
      for(let index=0;index<s.parts.length;index++){
        if(this.closed)return;
        await this.bus.publish({scope:group.scope,responseId:s.responseId,attemptId:s.attemptId,
          sequence:s.sequence,type:'response.snapshot',data:{requestId,index,count:s.parts.length,
            content:s.parts[index],status:s.status,terminal:s.terminal}});
      }
    }
  }
  async close(){
    this.closed=true;
    for(const g of this.scopes.values()){
      for(const s of g.states)clearTimeout(s.timer);
      g.states.clear();g.unsubscribe?.();
    }
    await Promise.allSettled([...this.scopes.values()].map(g=>g.ready));
    this.scopes.clear();this.count=0;
  }
}
