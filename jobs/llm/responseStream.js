import { randomUUID } from 'node:crypto';

// Internal lifecycle of one provider invocation. The bus is injected; no
// storage writes, no dependency on the browser, no wait in the delta callback.
// A terminal provider event is not proof of conversation persistence.
export function createResponseStream({bus,scope,responseId=randomUUID(),attemptId=randomUUID(),observe=()=>{}}) {
  let sequence=0, ended=false, broken=false;
  function send(type,data={}) {
    const event={scope,responseId,attemptId,sequence:sequence++,type,data};
    try {observe(event);} catch {} // Recovery state must not interrupt inference.
    if(broken)return;
    try {
      Promise.resolve(bus.publish(event))
        .catch(()=>{broken=true;});
    } catch {broken=true;}
  }
  send('response.started');
  return {
    responseId,
    onDelta({content,outputIndex,contentIndex}) {
      if(!ended&&typeof content==='string'&&content.length)
        send('response.delta',{content,outputIndex,contentIndex});
    },
    finish(message) {
      if(ended)return;ended=true;
      send('response.provider_finished',{hasText:typeof message?.content==='string'&&message.content.length>0});
    },
    fail(code) {
      if(ended)return;ended=true;
      send('response.failed',{code});
    }
  };
}
