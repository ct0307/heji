import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientFault } from '../../apps/web/src/api.ts';
import * as finance from '../../apps/web/src/finance.ts';

function helper(){
  const refresh=Reflect.get(finance,'refreshStalePreview');
  assert.equal(typeof refresh,'function','refreshStalePreview尚未实现');
  return refresh;
}

test('PREVIEW_STALE只读取一次最新预览并返回它',async()=>{
  const refresh=helper(),latest={expectedRequestRevision:'2',expectedFinancialVersion:'9'};let reads=0;
  const events:string[]=[];
  const result=await Reflect.apply(refresh,undefined,[new ClientFault(409,'PREVIEW_STALE','版本变化'),()=>events.push('invalidate'),async()=>{reads++;events.push('read');return latest}]);
  assert.deepEqual(result,{kind:'fresh',preview:latest});assert.equal(reads,1);assert.deepEqual(events,['invalidate','read']);
});

test('其他409不读取预览',async()=>{
  const refresh=helper();let reads=0;
  const result=await Reflect.apply(refresh,undefined,[new ClientFault(409,'TRANSFER_ALREADY_REVERSED','已冲正'),()=>{},async()=>{reads++;return null}]);
  assert.deepEqual(result,{kind:'unrelated'});assert.equal(reads,0);
});

test('最新预览读取失败返回失败结果',async()=>{
  const refresh=helper(),failure=new Error('网络中断');
  const result=await Reflect.apply(refresh,undefined,[new ClientFault(409,'PREVIEW_STALE','版本变化'),()=>{},async()=>{throw failure}]);
  assert.deepEqual(result,{kind:'failed',error:failure});
});

test('新预览的版本字段变化会生成新的幂等键',()=>{
  const intents=finance.createIntentStore(),path='/books/example/transfer-requests/request/confirm';
  const first=intents.headers(path,{expectedRequestRevision:'1',expectedFinancialVersion:'8'})['Idempotency-Key'];
  const next=intents.headers(path,{expectedRequestRevision:'1',expectedFinancialVersion:'9'})['Idempotency-Key'];
  assert.notEqual(next,first);
});
