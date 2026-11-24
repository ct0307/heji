export interface SyncSocket {
  onopen:(()=>void)|null;onmessage:((event:{data:unknown})=>void)|null;
  onclose:((event:{code:number})=>void)|null;onerror:(()=>void)|null;
  send(data:string):void;close():void;
}
export interface SyncClock {timeout(run:()=>void,delay:number):unknown;interval(run:()=>void,delay:number):unknown;clear(id:unknown):void}
export type SyncState='connecting'|'live'|'offline'|'stopped';
interface Options {bookId:string;connect:()=>SyncSocket;sync:()=>Promise<void>;state:(value:SyncState)=>void;authRequired:()=>void;revoked:()=>void;clock?:SyncClock;random?:()=>number}
const defaultClock:SyncClock={timeout:(run,delay)=>setTimeout(run,delay),interval:(run,delay)=>setInterval(run,delay),clear:id=>{clearTimeout(id as ReturnType<typeof setTimeout>);clearInterval(id as ReturnType<typeof setInterval>)}};
export function browserSocket(url:string):SyncSocket {
  const native=new WebSocket(url),socket:SyncSocket={onopen:null,onmessage:null,onclose:null,onerror:null,send:data=>native.send(data),close:()=>native.close()};
  native.onopen=()=>socket.onopen?.();native.onmessage=event=>socket.onmessage?.({data:event.data});
  native.onclose=event=>socket.onclose?.({code:event.code});native.onerror=()=>socket.onerror?.();return socket;
}
/** 事件只触发HTTP重读；与Vue无关，确保一轮重连、有限去重和可见期间补查可独立验证。 */
export function createRealtimeSync(options:Options) {
  const clock=options.clock??defaultClock,random=options.random??Math.random,seen=new Set<string>();
  let active=false,visible=true,socket:SyncSocket|null=null,reconnect:unknown,periodic:unknown,handshake:unknown,attempt=0,inFlight=false,pending=false;
  function clearHandshake(){if(handshake!==undefined){clock.clear(handshake);handshake=undefined}}
  function stop(){active=false;pending=false;clearHandshake();if(reconnect!==undefined)clock.clear(reconnect);if(periodic!==undefined)clock.clear(periodic);reconnect=undefined;periodic=undefined;const previous=socket;socket=null;if(previous){previous.onopen=null;previous.onmessage=null;previous.onclose=null;previous.onerror=null;previous.close()}options.state('stopped')}
  function auth(){stop();options.authRequired()}
  function revoked(){stop();options.revoked()}
  async function synchronize(){
    if(!active||!visible)return;
    if(inFlight){pending=true;return}
    inFlight=true;
    try{do{pending=false;try{await options.sync()}catch(error){if(!active)break;const status=(error as {status?:number})?.status;if(status===401){auth();break}if(status===404){revoked();break}}}while(active&&visible&&pending)}
    finally{inFlight=false}
  }
  function schedule(){
    if(!active||reconnect!==undefined)return;
    options.state('offline');
    const base=Math.min(30000,1000*2**Math.min(attempt++,5)),delay=Math.min(30000,Math.round(base*(0.75+random()*0.5)));
    reconnect=clock.timeout(()=>{reconnect=undefined;connect()},delay);
  }
  function connect(){
    if(!active)return;options.state('connecting');
    let current:SyncSocket;
    try{current=options.connect();socket=current}catch{schedule();void synchronize();return}
    const isCurrent=()=>active&&socket===current;
    handshake=clock.timeout(()=>{handshake=undefined;if(isCurrent()){socket=null;current.close();schedule();void synchronize()}},10000);
    current.onopen=()=>{if(isCurrent())current.send(JSON.stringify({type:'SUBSCRIBE',bookId:options.bookId}))};
    current.onmessage=event=>{
      if(!isCurrent()||typeof event.data!=='string'||event.data.length>4096)return;
      let value:Record<string,unknown>;try{value=JSON.parse(event.data);if(!value||typeof value!=='object')return}catch{return}
      if(value.bookId!==options.bookId)return;
      if(value.type==='SUBSCRIBED'){clearHandshake();attempt=0;options.state('live');void synchronize()}
      if(value.type==='SUBSCRIPTION_REVOKED'||value.type==='ERROR'&&value.code==='BOOK_FORBIDDEN'){revoked();return}
      if(value.type==='BOOK_CHANGED'&&typeof value.eventId==='string'){
        if(seen.has(value.eventId))return;seen.add(value.eventId);if(seen.size>512)seen.delete(seen.values().next().value!);void synchronize();
      }
    };
    current.onclose=event=>{if(!isCurrent())return;socket=null;clearHandshake();if(event.code===4401){auth();return}schedule();void synchronize()};
    current.onerror=()=>{if(!isCurrent())return;socket=null;clearHandshake();current.close();schedule();void synchronize()};
  }
  return {start(){if(active)return;active=true;periodic=clock.interval(()=>{void synchronize()},30000);connect()},stop,visible(value:boolean){visible=value;if(value)void synchronize()}};
}
