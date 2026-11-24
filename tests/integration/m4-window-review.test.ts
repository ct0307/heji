import test from 'node:test';
import assert from 'node:assert/strict';
import { windowReviewDeadline,windowReviewValid,createIntentStore } from '../../apps/web/src/finance.ts';
import type { SettlementWindowDto } from '../../packages/contracts/src/index.ts';
const window:SettlementWindowDto={supported:true,state:'ACTIVE',serverTime:'2026-11-19T00:00:01Z',expiresAt:'2026-11-19T00:00:30Z',createdAt:'2026-11-19T00:00:00Z',closedAt:null,cooldownUntil:'2026-11-19T00:01:00Z',windowId:'window',requestId:'request',mine:true,canClose:true};
test('窗口倒计时使用服务器剩余时间及单调时钟，扣除整个往返，不依赖电脑墙上时间',()=>{
  const deadline=windowReviewDeadline(window,1000);
  assert.equal(deadline,30000);
  assert.equal(windowReviewValid(window,'window','request',deadline,29999),true);
  assert.equal(windowReviewValid(window,'window','request',deadline,30000),false);
  assert.equal(windowReviewValid(window,'window','request',deadline,31000),false);
});
test('失效、他人窗口和其他请求不能用旧勾选确认',()=>{
  for(const patch of [{state:'EXPIRED' as const},{mine:false},{windowId:'new'},{requestId:'other'}])assert.equal(windowReviewValid({...window,...patch},'window','request',30000,5000),false);
  assert.equal(windowReviewValid(null,'window','request',30000,5000),false);
});
test('申请响应丢失时重试原键，确认/关闭不能清除申请意图；明确新申请才换键',()=>{
  const intents=createIntentStore(),path='/window',first=intents.headers(path,{})['Idempotency-Key'];
  intents.headers('/confirm',{});intents.reset('/close');
  assert.equal(intents.headers(path,{})['Idempotency-Key'],first);
  intents.reset(path);assert.notEqual(intents.headers(path,{})['Idempotency-Key'],first);
});
