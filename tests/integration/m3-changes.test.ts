import test from 'node:test';
import assert from 'node:assert/strict';
import { CommittedChanges } from '../../apps/api/src/modules/realtime/changes.ts';
test('提交后通知失败不转化成业务失败，其他订阅者仍可执行',async()=>{
  const changes=new CommittedChanges();let called=0;
  changes.onChange(()=>{throw new Error('模拟通知层故障')});changes.onChange(async()=>{called++});
  await changes.publish([{type:'BOOK_CHANGED',eventId:'event',bookId:'book',entityType:'BOOK',entityId:'book',financialVersion:'1'}]);assert.equal(called,1);
});
