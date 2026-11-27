import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const MAX_LIVE_NOTIFY_BYTES = 7900;
const defaultChannel = 'awfl_live_v1';
const id = x => typeof x === 'string' && x.length > 0 && x.length <= 256 && !/[\x00-\x1f]/.test(x);
function scopeKey(scope) {
  if (!scope || !['userId','projectId','sessionId'].every(k=>id(scope[k]))) throw new TypeError('Invalid live event scope');
  return JSON.stringify([scope.userId,scope.projectId,scope.sessionId]);
}
function validate(event) {
  scopeKey(event?.scope);
  if (!id(event.responseId) || !id(event.attemptId) || !Number.isSafeInteger(event.sequence) ||
      event.sequence < 0 || typeof event.type !== 'string' || !/^response\.[a-z_]{1,32}$/.test(event.type) ||
      !event.data || typeof event.data !== 'object' || Array.isArray(event.data))
    throw new TypeError('Invalid live event');
  return event;
}
function checkKey(key) {
  if (!Buffer.isBuffer(key) || key.length!==32) throw new TypeError('Live event key must be 32 bytes');
}
export function encodeLiveEvent(event,key,channel=defaultChannel) {
  checkKey(key); validate(event);
  const clear=Buffer.from(JSON.stringify(event));
  if(clear.length>MAX_LIVE_NOTIFY_BYTES) throw new RangeError('Live event exceeds notification size');
  const nonce=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(Buffer.from(channel));
  const encrypted=Buffer.concat([cipher.update(clear),cipher.final()]);
  const payload=Buffer.concat([nonce,cipher.getAuthTag(),encrypted]).toString('base64');
  if(Buffer.byteLength(payload)>MAX_LIVE_NOTIFY_BYTES) throw new RangeError('Live event exceeds notification size');
  return payload;
}
export function decodeLiveEvent(payload,key,channel=defaultChannel) {
  checkKey(key);
  if(typeof payload!=='string'||payload.length>MAX_LIVE_NOTIFY_BYTES) throw new TypeError('Invalid live notification');
  const bytes=Buffer.from(payload,'base64');
  if(bytes.length<29) throw new TypeError('Invalid live notification');
  const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
  decipher.setAAD(Buffer.from(channel));decipher.setAuthTag(bytes.subarray(12,28));
  return validate(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8')));
}

// Pools are externally owned and intentionally separate from document Storage.
// A process uses one FIFO publisher and one lazy dedicated LISTEN connection.
// This transport is transient: no replay, retry of uncertain writes, or DB rows.
export class PostgresLiveBus {
  constructor({publisherPool,listenerPool,sharedTransport,key,channel=defaultChannel,maxPending=256,reconnectMs=1000}={}) {
    if((sharedTransport ? (!sharedTransport.publish||!sharedTransport.subscribe||channel!==defaultChannel) : (!publisherPool?.query||!listenerPool?.connect)) || !/^[a-z][a-z0-9_]{0,62}$/.test(channel) ||
      !Number.isSafeInteger(maxPending)||maxPending<1||maxPending>4096 ||
      !Number.isSafeInteger(reconnectMs)||reconnectMs<10) throw new TypeError('Invalid live bus configuration');
    checkKey(key);
    this.publisherPool=publisherPool;this.listenerPool=listenerPool;this.sharedTransport=sharedTransport;this.sharedStop=null;this.sharedReady=false;this.key=Buffer.from(key);
    this.channel=channel;this.maxPending=maxPending;this.reconnectMs=reconnectMs;
    this.pending=0;this.peakPending=0;this.tail=Promise.resolve();
    this.subscribers=new Map();this.client=null;this.connecting=null;this.retry=null;this.closed=false;
  }
  publish(event) {
    if(this.closed) return Promise.reject(new Error('Live bus closed'));
    if(this.pending>=this.maxPending) return Promise.reject(new Error('Live publish queue full'));
    let payload;
    try {payload=encodeLiveEvent(event,this.key,this.channel);} catch(e){return Promise.reject(e);}
    this.pending++;this.peakPending=Math.max(this.peakPending,this.pending);
    const task=this.tail.then(()=>this.sharedTransport?this.sharedTransport.publish(payload):this.publisherPool.query('SELECT pg_notify($1,$2)',[this.channel,payload]));
    const result=task.finally(()=>{this.pending--;});
    this.tail=result.catch(()=>{});
    return result;
  }
  async subscribe(scope,onEvent,{onStatus=()=>{}}={}) {
    const key=scopeKey(scope);
    if(this.closed||typeof onEvent!=='function'||typeof onStatus!=='function') throw new TypeError('Invalid live subscription');
    const sub={key,onEvent,onStatus};let group=this.subscribers.get(key);
    if(!group){group=new Set();this.subscribers.set(key,group);}
    group.add(sub);
    try {await this.#ensure();if(!(this.sharedTransport?this.sharedReady:this.client)||this.closed)throw Error('Live listener unavailable');}
    catch(e){this.#remove(sub);throw e;}
    this.#call(sub,onStatus,'ready');
    return ()=>this.#remove(sub);
  }
  #call(sub,fn,arg) {
    try {
      const result=fn(arg);
      if(result&&typeof result.then==='function') {Promise.resolve(result).catch(()=>{});this.#remove(sub);}
    } catch {this.#remove(sub);}
  }
  #remove(sub) {
    const group=this.subscribers.get(sub.key);group?.delete(sub);
    if(group?.size===0)this.subscribers.delete(sub.key);
    if(!this.subscribers.size)this.#idle();
  }
  #status(status) {
    for(const group of [...this.subscribers.values()])for(const sub of [...group])this.#call(sub,sub.onStatus,status);
  }
  #notify(message) {
    if(message.channel!==this.channel)return;
    let event;try{event=decodeLiveEvent(message.payload,this.key,this.channel);}catch{return;}
    const group=this.subscribers.get(scopeKey(event.scope));
    if(group)for(const sub of [...group])this.#call(sub,sub.onEvent,event);
  }
  #idle() {
    if(this.sharedTransport){this.sharedStop?.();this.sharedStop=null;this.sharedReady=false;return;}
    clearTimeout(this.retry);this.retry=null;
    const client=this.client;this.client=null;
    if(client){try{client.release(true);}catch{}}
  }
  #lost(client) {
    if(this.client!==client)return;
    this.client=null;try{client.release(true);}catch{}
    this.#status('gap');this.#schedule();
  }
  #schedule() {
    if(this.closed||!this.subscribers.size||this.retry||this.client)return;
    this.retry=setTimeout(()=>{this.retry=null;void this.#ensure().then(()=>{if(this.client)this.#status('ready');}).catch(()=>this.#schedule());},this.reconnectMs);
    this.retry.unref?.();
  }
  async #ensureShared(){
    if(this.sharedStop)return;
    if(this.connecting)return this.connecting;
    this.connecting=(async()=>{
      let initialized=false;
      const stop=await this.sharedTransport.subscribe(payload=>this.#notify({channel:this.channel,payload}),status=>{
        this.sharedReady=status==='ready';if(initialized)this.#status(status);
      });
      if(this.closed||!this.subscribers.size){stop();this.sharedReady=false;throw Error('Live listener unavailable');}
      this.sharedStop=stop;initialized=true;
    })();
    try{await this.connecting;}finally{this.connecting=null;}
  }
  async #ensure() {
    if(this.sharedTransport)return this.#ensureShared();
    if(this.client)return;
    if(this.connecting)return this.connecting;
    this.connecting=(async()=>{
      const client=await this.listenerPool.connect();
      let failed=false;
      client.on('error',()=>{failed=true;this.#lost(client);});
      client.on('end',()=>{failed=true;this.#lost(client);});
      client.on('notification',m=>{if(this.client===client)this.#notify(m);});
      try{
        await client.query('LISTEN '+this.channel);
        if(failed||this.closed||!this.subscribers.size)throw Error('Live listener unavailable');
        this.client=client;
      }catch(e){try{client.release(true);}catch{}throw e;}
    })();
    try{await this.connecting;}finally{this.connecting=null;}
  }
  async close() {
    this.closed=true;this.subscribers.clear();this.#idle();
    await this.connecting?.catch(()=>{});
    await this.tail;
    this.key.fill(0);
  }
}
