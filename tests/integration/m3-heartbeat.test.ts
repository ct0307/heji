import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeartbeat } from '../../apps/api/src/modules/realtime/heartbeat.ts';

test('服务端30秒Ping、10秒无Pong终止；Pong与断开清理计时器',()=>{
  const timers=new Map<number,{run:()=>void;delay:number;interval:boolean}>();let id=0,pings=0,terminated=0;
  const clock={interval(run:()=>void,delay:number){timers.set(++id,{run,delay,interval:true});return id},timeout(run:()=>void,delay:number){timers.set(++id,{run,delay,interval:false});return id},clear(key:unknown){timers.delete(key as number)}};
  const beat=createHeartbeat({ping(){pings++},timeout(){terminated++},check(){}},clock);
  assert.equal(timers.size,1);assert.equal([...timers.values()][0]!.delay,30000);
  [...timers.values()][0]!.run();assert.equal(pings,1);assert.equal([...timers.values()].find(t=>!t.interval)!.delay,10000);
  beat.pong();assert.equal(timers.size,1);assert.equal(terminated,0);
  [...timers.values()][0]!.run();[...timers.values()].find(t=>!t.interval)!.run();assert.equal(terminated,1);
  beat.stop();assert.equal(timers.size,0);
});
