interface Clock {interval(run:()=>void,delay:number):unknown;timeout(run:()=>void,delay:number):unknown;clear(id:unknown):void}
const realClock:Clock={interval(run,delay){const timer=setInterval(run,delay);timer.unref();return timer},timeout(run,delay){const timer=setTimeout(run,delay);timer.unref();return timer},clear(id){clearTimeout(id as ReturnType<typeof setTimeout>);clearInterval(id as ReturnType<typeof setInterval>)}};
/** 独立管理控制帧心跳，不通过业务消息模拟Pong。 */
export function createHeartbeat(callbacks:{ping:()=>void;timeout:()=>void;check:()=>void},clock:Clock=realClock){
  let deadline:unknown,stopped=false;
  const periodic=clock.interval(()=>{if(stopped||deadline!==undefined)return;deadline=clock.timeout(()=>{stop();callbacks.timeout()},10000);callbacks.ping();callbacks.check()},30000);
  function stop(){stopped=true;clock.clear(periodic);if(deadline!==undefined)clock.clear(deadline);deadline=undefined}
  return {pong(){if(deadline!==undefined)clock.clear(deadline);deadline=undefined},stop};
}
