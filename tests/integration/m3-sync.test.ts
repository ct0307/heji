import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealtimeSync,type SyncSocket,type SyncClock } from '../../apps/web/src/realtime-client.ts';

class FakeSocket implements SyncSocket {
  onopen:(()=>void)|null=null;onmessage:((event:{data:unknown})=>void)|null=null;onclose:((event:{code:number})=>void)|null=null;onerror:(()=>void)|null=null;
  sent:string[]=[];closed=false;send(data:string){this.sent.push(data)}close(){this.closed=true}
  open(){this.onopen?.()}message(data:unknown){this.onmessage?.({data:JSON.stringify(data)})}end(code=1006){this.onclose?.({code})}
}
function fixture(){
  let next=0;const timers=new Map<number,{run:()=>void;delay:number;interval:boolean}>();
  const clock:SyncClock={timeout(run,delay){const id=++next;timers.set(id,{run,delay,interval:false});return id},interval(run,delay){const id=++next;timers.set(id,{run,delay,interval:true});return id},clear(id){timers.delete(id as number)}};
  const sockets:FakeSocket[]=[],states:string[]=[];let syncs=0,auth=0,revoked=0;
  const controller=createRealtimeSync({bookId:'00000000-0000-4000-8000-000000000001',connect(){const socket=new FakeSocket();sockets.push(socket);return socket},sync:async()=>{syncs++},state(value){states.push(value)},authRequired(){auth++},revoked(){revoked++},clock,random:()=>0.5});
  return {controller,sockets,states,timers,get syncs(){return syncs},get auth(){return auth},get revoked(){return revoked},fire(delay:number){const entries=[...timers].filter(([,value])=>value.delay===delay);assert.ok(entries.length);for(const [id,timer] of entries){if(!timer.interval)timers.delete(id);timer.run()}}};
}
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve()};
const event=(id:string,version='1')=>({type:'BOOK_CHANGED',eventId:id,bookId:'00000000-0000-4000-8000-000000000001',entityType:'EXPENSE',entityId:'x',financialVersion:version});
test('实时控制器重连后HTTP补查，相同事件去重但同版本新事件仍同步',async()=>{
  const f=fixture();f.controller.start();assert.equal(f.sockets.length,1);const ws=f.sockets[0]!;ws.open();assert.equal(f.syncs,0);
  assert.equal(JSON.parse(ws.sent[0]!).type,'SUBSCRIBE');ws.message({type:'SUBSCRIBED',bookId:event('x').bookId});await flush();assert.equal(f.syncs,1);
  ws.message(event('one'));await flush();assert.equal(f.syncs,2);ws.message(event('one'));await flush();assert.equal(f.syncs,2);
  ws.message(event('two'));await flush();assert.equal(f.syncs,3);ws.message({...event('other'),bookId:'other-book'});await flush();assert.equal(f.syncs,3);
  f.controller.stop();assert.equal(f.timers.size,0);assert.ok(ws.closed);
});
test('只有一轮带抖动退避，认证失效停止；旧连接回调和卸载不会重建',async()=>{
  const f=fixture();f.controller.start();const ws=f.sockets[0]!;ws.end();ws.end();assert.equal([...f.timers.values()].filter(x=>!x.interval).length,1);
  f.fire(1000);assert.equal(f.sockets.length,2);ws.open();assert.equal(ws.sent.length,0);
  f.sockets[1]!.end(4401);await flush();assert.equal(f.auth,1);assert.equal(f.timers.size,0);f.controller.visible(true);assert.equal(f.sockets.length,2);
});
test('可见时30秒补查、恢复可见立即补查，退出成员停止订阅',async()=>{
  const f=fixture();f.controller.start();f.fire(30000);await flush();assert.equal(f.syncs,1);
  f.controller.visible(false);f.fire(30000);await flush();assert.equal(f.syncs,1);
  f.controller.visible(true);await flush();assert.equal(f.syncs,2);
  f.sockets[0]!.message({type:'SUBSCRIPTION_REVOKED',bookId:event('x').bookId});await flush();assert.equal(f.revoked,1);assert.equal(f.timers.size,0);
});
test('网络失败不重叠HTTP补查，下一次可见性/周期仍可恢复',async()=>{
  let resolve:()=>void=()=>{};let calls=0;
  const socket=new FakeSocket(),controller=createRealtimeSync({bookId:'book',connect:()=>socket,sync:()=>{calls++;return new Promise<void>(done=>{resolve=done})},state(){},authRequired(){},revoked(){}});
  controller.start();controller.visible(true);controller.visible(true);assert.equal(calls,1);resolve();await flush();assert.equal(calls,2);resolve();await flush();controller.stop();
});
test('卸载后的旧HTTP鉴权失败不触发新页面退出',async()=>{
  let reject:(error:unknown)=>void=()=>{};let auth=0;
  const socket=new FakeSocket(),controller=createRealtimeSync({bookId:'book',connect:()=>socket,sync:()=>new Promise<void>((_,fail)=>{reject=fail}),state(){},authRequired(){auth++},revoked(){}});
  controller.start();controller.visible(true);controller.stop();reject({status:401});await flush();assert.equal(auth,0);
});
